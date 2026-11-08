import { z } from "zod";
import { authenticate, json } from "@/lib/api-auth";
import { quoteRedemption } from "@/lib/loyalty";

export const dynamic = "force-dynamic";

/** POST /api/v1/loyalty/quote {customer_id, subtotal_cents, points?} → how many points can apply and the discount. */
export async function POST(req: Request) {
  const raw = await req.text();
  const auth = await authenticate(req, raw);
  if (auth instanceof Response) return auth;
  const p = z.object({ customer_id: z.string(), subtotal_cents: z.number().int().min(0), points: z.number().int().min(0).optional() }).safeParse(JSON.parse(raw || "{}"));
  if (!p.success) return json({ error: "validation", issues: p.error.issues }, 422);
  const q = await quoteRedemption(p.data.customer_id, auth.client.brandId, p.data.subtotal_cents, p.data.points);
  return json({ balance: q.balance, redeemable_points: q.points, discount_cents: q.discountCents, min_redeem_points: q.minRedeemPoints });
}
