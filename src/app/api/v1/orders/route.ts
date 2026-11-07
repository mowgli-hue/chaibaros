import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { locations, orders } from "@/db/schema";
import { authenticate, clientMayUseLocation, json } from "@/lib/api-auth";
import { createOrder, inboundOrderSchema } from "@/lib/orders";

export const dynamic = "force-dynamic";

/** POST /api/v1/orders — ingest an order from App Thru / Vlink / TiffinGo. Idempotent. */
export async function POST(req: Request) {
  const raw = await req.text();
  const auth = await authenticate(req, raw);
  if (auth instanceof Response) return auth;
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "invalid JSON" }, 400); }
  // Channel is fixed by the client credential, not the payload.
  const parsed = inboundOrderSchema.safeParse({ ...(body as object), channel: auth.client.channel });
  if (!parsed.success) return json({ error: "validation", issues: parsed.error.issues }, 422);
  const input = parsed.data;
  if (!clientMayUseLocation(auth.client, input.location_id)) return json({ error: "client not allowed for this location" }, 403);
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, input.location_id), eq(locations.brandId, auth.client.brandId)));
  if (!loc) return json({ error: "unknown location for this brand" }, 404);
  try {
    const { order, created } = await createOrder(input, null);
    return json({ order_id: order.id, number: order.number, status: order.status, total_cents: order.totalCents, created }, created ? 201 : 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "failed" }, 400);
  }
}

/** GET /api/v1/orders?location_id=&since=ISO&status=a,b — polling for Vlink. */
export async function GET(req: Request) {
  const auth = await authenticate(req, "");
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const locationId = url.searchParams.get("location_id");
  const since = url.searchParams.get("since");
  const statuses = url.searchParams.get("status")?.split(",").filter(Boolean) as (typeof orders.$inferSelect)["status"][] | undefined;
  if (!locationId || !clientMayUseLocation(auth.client, locationId)) return json({ error: "location_id required / not allowed" }, 403);
  const rows = await db.query.orders.findMany({
    where: (o, { and, eq, gte, inArray }) => and(eq(o.locationId, locationId), eq(o.brandId, auth.client.brandId), since ? gte(o.placedAt, new Date(since)) : undefined, statuses?.length ? inArray(o.status, statuses) : undefined),
    with: { items: true },
    orderBy: (o, { desc }) => desc(o.placedAt),
    limit: 200,
  });
  void desc; void gte; void inArray;
  return json({ orders: rows.map(serialize) });
}

export function serialize(o: typeof orders.$inferSelect & { items?: Array<Record<string, unknown>> }) {
  return {
    order_id: o.id,
    number: o.number,
    external_id: o.externalId,
    channel: o.channel,
    status: o.status,
    fulfilment: o.fulfilment,
    requested_at: o.requestedAt,
    ready_by: o.readyBy,
    customer: { name: o.customerName, phone: o.customerPhone },
    notes: o.notes,
    totals: { subtotal_cents: o.subtotalCents, discount_cents: o.discountCents, gst_cents: o.gstCents, pst_cents: o.pstCents, tip_cents: o.tipCents, fee_cents: o.feeCents, total_cents: o.totalCents },
    payment: { status: o.paymentStatus, provider: o.paymentProvider, tender: o.tender },
    placed_at: o.placedAt,
    items: o.items,
  };
}
