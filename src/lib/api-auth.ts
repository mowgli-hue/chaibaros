import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiClients } from "@/db/schema";

export type ApiAuth = { client: typeof apiClients.$inferSelect };

/**
 * Request auth for /api/v1/*:
 *   X-Api-Key: <keyId>
 *   X-Signature: hex(HMAC-SHA256(secret, rawBody))   (GET requests sign the empty string)
 *   X-Timestamp: unix seconds (rejected if older than 5 minutes)
 */
export async function authenticate(req: Request, rawBody: string): Promise<ApiAuth | Response> {
  const keyId = req.headers.get("x-api-key");
  const sig = req.headers.get("x-signature") ?? "";
  const ts = Number(req.headers.get("x-timestamp") ?? 0);
  if (!keyId) return json({ error: "missing X-Api-Key" }, 401);
  const client = await db.query.apiClients.findFirst({ where: (c, { eq }) => eq(c.keyId, keyId) });
  if (!client || !client.active) return json({ error: "unknown or inactive client" }, 401);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return json({ error: "stale or missing X-Timestamp" }, 401);
  const expected = createHmac("sha256", client.secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: "bad signature" }, 401);
  await db.update(apiClients).set({ lastUsedAt: new Date() }).where(eq(apiClients.id, client.id));
  return { client };
}

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** Helper for clients (documented in README): how to sign a request. */
export function signRequest(secret: string, ts: number, rawBody: string) {
  return createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
}

export function clientMayUseLocation(client: typeof apiClients.$inferSelect, locationId: string) {
  return client.locationIds.length === 0 || client.locationIds.includes(locationId);
}
