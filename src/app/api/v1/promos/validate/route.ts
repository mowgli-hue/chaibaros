import { z } from "zod";
import { authenticate, json } from "@/lib/api-auth";
import { validatePromo } from "@/lib/loyalty";

export const dynamic = "force-dynamic";

/** POST /api/v1/promos/validate {code, location_id, subtotal_cents, customer_id?, item_skus?} */
export async function POST(req: Request) {
  const raw = await req.text();
  const auth = await authenticate(req, raw);
  if (auth instanceof Response) return auth;
  const p = z.object({ code: z.string(), location_id: z.string(), subtotal_cents: z.number().int().min(0), customer_id: z.string().optional(), item_skus: z.array(z.string()).optional() }).safeParse(JSON.parse(raw || "{}"));
  if (!p.success) return json({ error: "validation", issues: p.error.issues }, 422);
  const r = await validatePromo({ brandId: auth.client.brandId, code: p.data.code, locationId: p.data.location_id, channel: auth.client.channel, subtotalCents: p.data.subtotal_cents, customerId: p.data.customer_id, itemSkus: p.data.item_skus });
  if (!r.ok) return json({ valid: false, reason: r.reason });
  return json({ valid: true, code: r.promotion.code, name: r.promotion.name, kind: r.promotion.kind, discount_cents: r.discountCents, free_item_sku: r.promotion.freeItemSku });
}
