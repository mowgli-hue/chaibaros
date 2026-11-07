import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { db } from "@/db";
import { apiClients, webhookDeliveries } from "@/db/schema";

/** Queue an event for every active API client of the brand that has a webhook URL. Delivery is attempted inline once; retries run from the cron route. */
export async function enqueueWebhooks(brandId: string, event: string, payload: Record<string, unknown>) {
  const clients = await db.select().from(apiClients).where(and(eq(apiClients.brandId, brandId), eq(apiClients.active, true)));
  const targets = clients.filter((c) => c.webhookUrl && (c.locationIds.length === 0 || (payload.location_id && c.locationIds.includes(String(payload.location_id)))));
  if (!targets.length) return;
  const rows = await db
    .insert(webhookDeliveries)
    .values(targets.map((c) => ({ apiClientId: c.id, url: c.webhookUrl!, event, payload: { event, ...payload, sent_at: new Date().toISOString() }, nextAttemptAt: new Date() })))
    .returning();
  await Promise.allSettled(rows.map((r) => deliver(r.id)));
}

export async function deliver(id: string) {
  const row = await db.query.webhookDeliveries.findFirst({ where: (w, { eq }) => eq(w.id, id) });
  if (!row || row.deliveredAt) return;
  const client = row.apiClientId ? await db.query.apiClients.findFirst({ where: (c, { eq }) => eq(c.id, row.apiClientId!) }) : null;
  const body = JSON.stringify(row.payload);
  const sig = client ? createHmac("sha256", client.secret).update(body).digest("hex") : "";
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(row.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-chaibar-event": row.event, "x-chaibar-signature": sig, "x-chaibar-delivery": row.id },
      body,
      signal: AbortSignal.timeout(8000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const attempts = row.attempts + 1;
  const backoffMin = Math.min(24 * 60, 2 ** attempts); // 2,4,8,… minutes, capped at 24h
  await db
    .update(webhookDeliveries)
    .set({
      attempts,
      lastStatus: status,
      lastError: error,
      deliveredAt: error ? null : new Date(),
      nextAttemptAt: error && attempts < 12 ? new Date(Date.now() + backoffMin * 60000) : null,
    })
    .where(eq(webhookDeliveries.id, id));
}

/** Called by the cron route: retry everything due. */
export async function retryDueWebhooks(limit = 50) {
  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(isNull(webhookDeliveries.deliveredAt), or(isNull(webhookDeliveries.nextAttemptAt), lte(webhookDeliveries.nextAttemptAt, new Date())), sql`${webhookDeliveries.attempts} < 12`))
    .limit(limit);
  for (const d of due) await deliver(d.id);
  return due.length;
}
