import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, loyaltyAccounts, loyaltyLedger, loyaltyPrograms, orders, promoRedemptions, promotions, type LoyaltyProgram, type Promotion } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Dbx = Tx | typeof db;

export async function getProgram(brandId: string, dbx: Dbx = db): Promise<LoyaltyProgram> {
  const [p] = await dbx.select().from(loyaltyPrograms).where(eq(loyaltyPrograms.brandId, brandId));
  if (p) return p;
  const [created] = await dbx.insert(loyaltyPrograms).values({ brandId }).onConflictDoNothing().returning();
  return created ?? (await dbx.select().from(loyaltyPrograms).where(eq(loyaltyPrograms.brandId, brandId)))[0];
}

/** Ensure an account exists; grants the signup bonus once. */
export async function ensureAccount(customerId: string, brandId: string, dbx: Dbx = db) {
  const existing = await dbx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, customerId));
  if (existing[0]) return existing[0];
  const program = await getProgram(brandId, dbx);
  const referralCode = `CHAI-${customerId.slice(0, 6).toUpperCase()}`;
  const [acct] = await dbx
    .insert(loyaltyAccounts)
    .values({ customerId, brandId, balance: program.signupBonusPoints, lifetimeEarned: program.signupBonusPoints, referralCode })
    .onConflictDoNothing()
    .returning();
  if (acct && program.signupBonusPoints > 0) {
    await dbx.insert(loyaltyLedger).values({ customerId, kind: "signup", delta: program.signupBonusPoints, balanceAfter: program.signupBonusPoints, note: "Welcome bonus" });
  }
  return acct ?? (await dbx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, customerId)))[0];
}

/** Earn points for a completed order. Idempotent per (order, kind). Returns points earned. */
export async function earnForOrder(orderId: string, dbx: Dbx = db) {
  const [o] = await dbx.select().from(orders).where(eq(orders.id, orderId));
  if (!o || !o.customerId) return 0;
  const program = await getProgram(o.brandId, dbx);
  if (!program.active || !program.earnOnChannels.includes(o.channel)) return 0;
  const net = Math.max(0, o.subtotalCents - o.discountCents);
  const points = Math.floor((net / 100) * program.pointsPerDollar);
  if (points <= 0) return 0;
  const acct = await ensureAccount(o.customerId, o.brandId, dbx);
  const inserted = await dbx
    .insert(loyaltyLedger)
    .values({ customerId: o.customerId, orderId, kind: "earn", delta: points, balanceAfter: acct.balance + points, note: `Order #${o.number}` })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) return 0; // already earned
  await dbx
    .update(loyaltyAccounts)
    .set({ balance: sql`${loyaltyAccounts.balance} + ${points}`, lifetimeEarned: sql`${loyaltyAccounts.lifetimeEarned} + ${points}` })
    .where(eq(loyaltyAccounts.customerId, o.customerId));
  await refreshTier(o.customerId, dbx);
  return points;
}

/** Reverse earned points when an order is refunded/cancelled after completion. */
export async function reverseForOrder(orderId: string, dbx: Dbx = db) {
  const [earned] = await dbx.select().from(loyaltyLedger).where(and(eq(loyaltyLedger.orderId, orderId), eq(loyaltyLedger.kind, "earn")));
  if (!earned) return 0;
  const [acct] = await dbx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, earned.customerId));
  const delta = -earned.delta;
  const ins = await dbx
    .insert(loyaltyLedger)
    .values({ customerId: earned.customerId, orderId, kind: "reversal", delta, balanceAfter: (acct?.balance ?? 0) + delta, note: "Order refunded" })
    .onConflictDoNothing()
    .returning();
  if (!ins.length) return 0;
  await dbx.update(loyaltyAccounts).set({ balance: sql`${loyaltyAccounts.balance} + ${delta}` }).where(eq(loyaltyAccounts.customerId, earned.customerId));
  return delta;
}

/** How much of an order can be paid with points. */
export async function quoteRedemption(customerId: string, brandId: string, subtotalCents: number, requestedPoints?: number) {
  const program = await getProgram(brandId);
  const [acct] = await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, customerId));
  const balance = acct?.balance ?? 0;
  const maxByOrder = Math.floor(((subtotalCents * program.maxRedeemPctOfOrder) / 100) / program.redeemCentsPerPoint);
  const points = Math.min(balance, maxByOrder, requestedPoints ?? Number.MAX_SAFE_INTEGER);
  const ok = points >= program.minRedeemPoints;
  return { program, balance, points: ok ? points : 0, discountCents: ok ? points * program.redeemCentsPerPoint : 0, minRedeemPoints: program.minRedeemPoints };
}

/** Lock in a redemption against an order. Idempotent per (order, 'redeem'). */
export async function redeemForOrder(orderId: string, customerId: string, points: number, actorId: string | null, dbx: Dbx = db) {
  const [acct] = await dbx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, customerId)).for("update");
  if (!acct || acct.balance < points) throw new Error("Insufficient points");
  const ins = await dbx
    .insert(loyaltyLedger)
    .values({ customerId, orderId, kind: "redeem", delta: -points, balanceAfter: acct.balance - points, actorId, note: "Redeemed on order" })
    .onConflictDoNothing()
    .returning();
  if (!ins.length) return;
  await dbx
    .update(loyaltyAccounts)
    .set({ balance: sql`${loyaltyAccounts.balance} - ${points}`, lifetimeRedeemed: sql`${loyaltyAccounts.lifetimeRedeemed} + ${points}` })
    .where(eq(loyaltyAccounts.customerId, customerId));
}

export async function adjustPoints(customerId: string, delta: number, note: string, actorId: string | null) {
  const [acct] = await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, customerId));
  if (!acct) throw new Error("No loyalty account");
  await db.transaction(async (tx) => {
    await tx.insert(loyaltyLedger).values({ customerId, kind: "adjust", delta, balanceAfter: acct.balance + delta, note, actorId });
    await tx.update(loyaltyAccounts).set({ balance: sql`${loyaltyAccounts.balance} + ${delta}` }).where(eq(loyaltyAccounts.customerId, customerId));
  });
}

async function refreshTier(customerId: string, dbx: Dbx) {
  const [c] = await dbx.select({ visits: customers.visits }).from(customers).where(eq(customers.id, customerId));
  const tier = (c?.visits ?? 0) >= 40 ? "vip" : (c?.visits ?? 0) >= 10 ? "regular" : "member";
  await dbx.update(loyaltyAccounts).set({ tier }).where(eq(loyaltyAccounts.customerId, customerId));
}

// ---------------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------------

export type PromoCheck = { ok: true; promotion: Promotion; discountCents: number } | { ok: false; reason: string };

export async function validatePromo(opts: { brandId: string; code: string; locationId: string; channel: string; subtotalCents: number; customerId?: string | null; itemSkus?: string[] }): Promise<PromoCheck> {
  const code = opts.code.trim().toUpperCase();
  const [p] = await db.select().from(promotions).where(and(eq(promotions.brandId, opts.brandId), eq(promotions.code, code)));
  if (!p || !p.active) return { ok: false, reason: "Unknown code" };
  const now = new Date();
  if (p.startsAt && p.startsAt > now) return { ok: false, reason: "Not started" };
  if (p.endsAt && p.endsAt < now) return { ok: false, reason: "Expired" };
  if (p.maxRedemptions != null && p.redemptions >= p.maxRedemptions) return { ok: false, reason: "Fully redeemed" };
  if (p.channels.length && !p.channels.includes(opts.channel)) return { ok: false, reason: "Not valid on this channel" };
  if (p.locationIds.length && !p.locationIds.includes(opts.locationId)) return { ok: false, reason: "Not valid at this store" };
  if (opts.subtotalCents < p.minSubtotalCents) return { ok: false, reason: `Minimum $${(p.minSubtotalCents / 100).toFixed(2)}` };
  if (opts.customerId) {
    if (p.oncePerCustomer) {
      const [used] = await db.select().from(promoRedemptions).where(and(eq(promoRedemptions.promotionId, p.id), eq(promoRedemptions.customerId, opts.customerId)));
      if (used) return { ok: false, reason: "Already used" };
    }
    if (p.firstOrderOnly) {
      const [c] = await db.select({ visits: customers.visits }).from(customers).where(eq(customers.id, opts.customerId));
      if ((c?.visits ?? 0) > 0) return { ok: false, reason: "First order only" };
    }
  } else if (p.firstOrderOnly || p.oncePerCustomer) {
    return { ok: false, reason: "Phone or account required for this code" };
  }
  let discount = 0;
  if (p.kind === "percent") discount = Math.round((opts.subtotalCents * p.value) / 100);
  else if (p.kind === "amount") discount = Math.min(p.value, opts.subtotalCents);
  else if (p.kind === "free_item") {
    if (!p.freeItemSku || !(opts.itemSkus ?? []).includes(p.freeItemSku)) return { ok: false, reason: "Add the free item to the order first" };
    discount = 0; // caller prices the free item at 0 via unit_price override; we record redemption only
  }
  return { ok: true, promotion: p, discountCents: discount };
}

export async function recordPromoRedemption(promotionId: string, orderId: string, customerId: string | null, discountCents: number, dbx: Dbx = db) {
  await dbx.insert(promoRedemptions).values({ promotionId, orderId, customerId, discountCents });
  await dbx.update(promotions).set({ redemptions: sql`${promotions.redemptions} + 1` }).where(eq(promotions.id, promotionId));
}
