import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, loyaltyAccounts } from "@/db/schema";
import { authenticate, json } from "@/lib/api-auth";
import { getProgram } from "@/lib/loyalty";
import { normalizePhone } from "@/lib/orders";

export const dynamic = "force-dynamic";

/** GET /api/v1/customers/lookup?phone=|email=|external_id= — balance, tier, visits for App Thru's profile screen. */
export async function GET(req: Request) {
  const auth = await authenticate(req, "");
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const phone = url.searchParams.get("phone");
  const email = url.searchParams.get("email");
  const externalId = url.searchParams.get("external_id");
  const brandId = auth.client.brandId;
  let c = phone
    ? (await db.select().from(customers).where(and(eq(customers.brandId, brandId), eq(customers.phone, normalizePhone(phone)))))[0]
    : email
      ? (await db.select().from(customers).where(and(eq(customers.brandId, brandId), eq(customers.email, email.toLowerCase()))))[0]
      : undefined;
  if (!c && externalId) {
    c = (await db.query.customers.findMany({ where: (t, { and, eq, sql }) => and(eq(t.brandId, brandId), sql`${t.externalIds} ->> ${auth.client.channel} = ${externalId}`), limit: 1 }))[0];
  }
  if (!c) return json({ found: false }, 404);
  const [acct] = await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, c.id));
  const program = await getProgram(brandId);
  return json({
    found: true,
    customer_id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    visits: c.visits,
    lifetime_cents: c.lifetimeCents,
    marketing_consent: c.marketingConsent,
    loyalty: {
      program: program.name,
      balance: acct?.balance ?? 0,
      tier: acct?.tier ?? "member",
      value_cents: (acct?.balance ?? 0) * program.redeemCentsPerPoint,
      min_redeem_points: program.minRedeemPoints,
      points_per_dollar: program.pointsPerDollar,
      referral_code: acct?.referralCode ?? null,
    },
  });
}
