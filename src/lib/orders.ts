import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  customers,
  factSalesDaily,
  itemLocationSettings,
  locations,
  menuItems,
  orderEvents,
  orderItems,
  orders,
  stockLevels,
  stockMovements,
  type Channel,
  type OrderStatus,
} from "@/db/schema";
import { fmtDate } from "./dates";
import { enqueueWebhooks } from "./webhooks";
import { earnForOrder, quoteRedemption, recordPromoRedemption, redeemForOrder, reverseForOrder, validatePromo } from "./loyalty";

// ---------------------------------------------------------------------------
// Tax (BC defaults; per-province rates live here so a franchisee in AB/ON is one row)
// ---------------------------------------------------------------------------

const TAX: Record<string, { gst: number; pst: number; hst?: number }> = {
  BC: { gst: 0.05, pst: 0.07 },
  AB: { gst: 0.05, pst: 0 },
  SK: { gst: 0.05, pst: 0.06 },
  MB: { gst: 0.05, pst: 0.07 },
  ON: { gst: 0.13, pst: 0 }, // HST recorded in gst column
  QC: { gst: 0.05, pst: 0.09975 },
};

export function taxFor(province: string, taxClass: string, cents: number) {
  const r = TAX[province] ?? TAX.BC;
  if (taxClass === "exempt") return { gst: 0, pst: 0 };
  const gst = Math.round(cents * r.gst);
  const pst = taxClass === "gst_pst" ? Math.round(cents * r.pst) : 0;
  return { gst, pst };
}

// ---------------------------------------------------------------------------
// Inbound order contract (same shape for App Thru, Vlink, TiffinGo, Clover mapper, manual POS)
// ---------------------------------------------------------------------------

export const inboundOrderSchema = z.object({
  idempotency_key: z.string().min(4).max(200),
  channel: z.enum(["counter", "clover", "app_thru", "vlink", "tiffingo", "uber_eats", "doordash", "skip", "other"]),
  external_id: z.string().optional(),
  location_id: z.string(),
  fulfilment: z
    .object({ type: z.enum(["dine_in", "pickup", "delivery"]).default("pickup"), requested_at: z.string().datetime().optional() })
    .default({ type: "pickup" }),
  customer: z
    .object({ phone: z.string().optional(), name: z.string().optional(), email: z.string().email().optional(), external_id: z.string().optional(), marketing_consent: z.boolean().optional() })
    .optional(),
  items: z
    .array(
      z.object({
        sku: z.string().optional(),
        item_id: z.string().optional(),
        name: z.string().optional(),
        qty: z.number().int().min(1).default(1),
        unit_price_cents: z.number().int().min(0).optional(),
        modifiers: z.array(z.object({ sku: z.string().optional(), name: z.string().optional(), price_cents: z.number().int().default(0) })).default([]),
        notes: z.string().optional(),
      }),
    )
    .min(1),
  totals: z
    .object({
      subtotal_cents: z.number().int().optional(),
      discount_cents: z.number().int().default(0),
      gst_cents: z.number().int().optional(),
      pst_cents: z.number().int().optional(),
      tip_cents: z.number().int().default(0),
      fee_cents: z.number().int().default(0),
      commission_cents: z.number().int().default(0),
      total_cents: z.number().int().optional(),
    })
    .default({ discount_cents: 0, tip_cents: 0, fee_cents: 0, commission_cents: 0 }),
  payment: z
    .object({ status: z.enum(["unpaid", "paid", "refunded"]).default("unpaid"), provider: z.string().optional(), reference: z.string().optional(), tender: z.string().optional() })
    .default({ status: "unpaid" as const }),
  notes: z.string().optional(),
  promo_code: z.string().optional(),
  redeem_points: z.number().int().min(0).optional(),
  placed_at: z.string().datetime().optional(),
  status: z.enum(["received", "accepted", "preparing", "ready", "completed", "cancelled", "refunded"]).optional(),
  raw: z.unknown().optional(),
});
export type InboundOrder = z.infer<typeof inboundOrderSchema>;

/**
 * Create an order from any channel. Idempotent on `idempotency_key`.
 * Resolves SKUs against the brand menu, applies store price overrides, computes tax
 * when the caller did not send it, upserts the customer, depletes stock by recipe,
 * writes the first event, and queues status webhooks.
 */
export async function createOrder(input: InboundOrder, actorId: string | null = null) {
  const existing = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.idempotencyKey, input.idempotency_key), with: { items: true } });
  if (existing) return { order: existing, created: false as const };

  const [loc] = await db.select().from(locations).where(eq(locations.id, input.location_id));
  if (!loc) throw new Error("Unknown location");

  // Resolve items against the menu.
  const skus = input.items.map((i) => i.sku).filter((s): s is string => Boolean(s));
  const ids = input.items.map((i) => i.item_id).filter((s): s is string => Boolean(s));
  const menu = skus.length || ids.length
    ? await db
        .select({ item: menuItems, override: itemLocationSettings })
        .from(menuItems)
        .leftJoin(itemLocationSettings, and(eq(itemLocationSettings.itemId, menuItems.id), eq(itemLocationSettings.locationId, loc.id)))
        .where(and(eq(menuItems.brandId, loc.brandId), or(skus.length ? inArray(menuItems.sku, skus) : undefined, ids.length ? inArray(menuItems.id, ids) : undefined)))
    : [];

  let subtotal = 0;
  let gstBase = 0; // taxable base for GST/HST
  let pstBase = 0; // taxable base for PST
  const lines = input.items.map((i) => {
    const m = menu.find((x) => (i.item_id && x.item.id === i.item_id) || (i.sku && x.item.sku === i.sku));
    const unit = i.unit_price_cents ?? m?.override?.priceCents ?? m?.item.priceCents ?? 0;
    const mods = i.modifiers.map((md) => ({ sku: md.sku, name: md.name ?? md.sku ?? "modifier", priceCents: md.price_cents }));
    const modTotal = mods.reduce((a, b) => a + b.priceCents, 0);
    const lineTotal = (unit + modTotal) * i.qty;
    subtotal += lineTotal;
    const cls = m?.item.taxClass ?? "gst_only";
    if (cls !== "exempt") gstBase += lineTotal;
    if (cls === "gst_pst") pstBase += lineTotal;
    return {
      itemId: m?.item.id ?? null,
      sku: i.sku ?? m?.item.sku ?? null,
      name: i.name ?? m?.item.name ?? i.sku ?? "Item",
      qty: i.qty,
      unitPriceCents: unit,
      modifiers: mods,
      notes: i.notes ?? null,
      station: m?.item.station ?? "bar",
      lineTotalCents: lineTotal,
      recipe: m?.item.recipe ?? [],
    };
  });

  const placedAt = input.placed_at ? new Date(input.placed_at) : new Date();
  const initialStatus: OrderStatus = input.status ?? (input.channel === "counter" || input.channel === "clover" ? "preparing" : input.channel === "app_thru" || input.channel === "vlink" || input.channel === "tiffingo" ? "accepted" : "received");

  const result = await db.transaction(async (tx) => {
    // Customer upsert by phone (then email). Totals are finalized after, because promos and points depend on the customer.
    let customerId: string | null = null;
    let totalCents = 0;
    const c = input.customer;
    if (c && (c.phone || c.email)) {
      const phone = c.phone ? normalizePhone(c.phone) : null;
      const found = phone
        ? await tx.query.customers.findFirst({ where: (t, { and, eq }) => and(eq(t.brandId, loc.brandId), eq(t.phone, phone)) })
        : await tx.query.customers.findFirst({ where: (t, { and, eq }) => and(eq(t.brandId, loc.brandId), eq(t.email, c.email!)) });
      if (found) {
        customerId = found.id;
        await tx
          .update(customers)
          .set({
            name: c.name ?? found.name,
            email: c.email ?? found.email,
            lastSeenAt: placedAt,
            visits: sql`${customers.visits} + 1`,
            ...(c.marketing_consent && !found.marketingConsent ? { marketingConsent: true, consentSource: input.channel, consentAt: new Date() } : {}),
            ...(c.external_id ? { externalIds: { ...found.externalIds, [input.channel]: c.external_id } } : {}),
          })
          .where(eq(customers.id, found.id));
      } else {
        const [nc] = await tx
          .insert(customers)
          .values({
            brandId: loc.brandId,
            name: c.name ?? null,
            phone,
            email: c.email ?? null,
            externalIds: c.external_id ? { [input.channel]: c.external_id } : {},
            marketingConsent: Boolean(c.marketing_consent),
            consentSource: c.marketing_consent ? input.channel : null,
            consentAt: c.marketing_consent ? new Date() : null,
            firstSeenAt: placedAt,
            lastSeenAt: placedAt,
            visits: 1,
            lifetimeCents: 0,
          })
          .returning();
        customerId = nc.id;
      }
    }

    // Promo code + points redemption → discount; then tax once on the aggregate (receipt-level rounding).
    let discount = input.totals.discount_cents ?? 0;
    let promo: Awaited<ReturnType<typeof validatePromo>> | null = null;
    if (input.promo_code) {
      promo = await validatePromo({ brandId: loc.brandId, code: input.promo_code, locationId: loc.id, channel: input.channel, subtotalCents: subtotal, customerId, itemSkus: lines.map((l) => l.sku ?? "") });
      if (!promo.ok) throw new Error(`Promo: ${promo.reason}`);
      discount += promo.discountCents;
    }
    let pointsToRedeem = 0;
    let pointsDiscount = 0;
    if (input.redeem_points && customerId) {
      const q = await quoteRedemption(customerId, loc.brandId, subtotal, input.redeem_points);
      if (q.points < input.redeem_points) throw new Error(`Loyalty: can redeem at most ${q.points} points on this order`);
      pointsToRedeem = q.points;
      pointsDiscount = q.discountCents;
      discount += pointsDiscount;
    }
    discount = Math.min(discount, subtotal);
    const factor = discount > 0 && subtotal > 0 ? Math.max(0, subtotal - discount) / subtotal : 1;
    const gst = input.totals.gst_cents ?? taxFor(loc.province, "gst_only", Math.round(gstBase * factor)).gst;
    const pst = input.totals.pst_cents ?? taxFor(loc.province, "gst_pst", Math.round(pstBase * factor)).pst;
    const totals = {
      subtotalCents: input.totals.subtotal_cents ?? subtotal,
      discountCents: discount,
      gstCents: gst,
      pstCents: pst,
      tipCents: input.totals.tip_cents ?? 0,
      feeCents: input.totals.fee_cents ?? 0,
      commissionCents: input.totals.commission_cents ?? 0,
    };
    totalCents = input.totals.total_cents ?? totals.subtotalCents - totals.discountCents + totals.gstCents + totals.pstCents + totals.tipCents + totals.feeCents;
    if (customerId) await tx.update(customers).set({ lifetimeCents: sql`${customers.lifetimeCents} + ${totalCents}` }).where(eq(customers.id, customerId));

    // Per-location daily ticket number.
    const day = fmtDate(placedAt);
    const [{ n }] = await tx
      .select({ n: sql<number>`coalesce(max(${orders.number}), 0) + 1` })
      .from(orders)
      .where(and(eq(orders.locationId, loc.id), sql`(${orders.placedAt} at time zone ${loc.timezone})::date = ${day}::date`));

    const [order] = await tx
      .insert(orders)
      .values({
        locationId: loc.id,
        brandId: loc.brandId,
        number: Number(n),
        channel: input.channel as Channel,
        externalId: input.external_id ?? null,
        idempotencyKey: input.idempotency_key,
        status: initialStatus,
        fulfilment: input.fulfilment.type,
        requestedAt: input.fulfilment.requested_at ? new Date(input.fulfilment.requested_at) : null,
        customerId,
        customerName: c?.name ?? null,
        customerPhone: c?.phone ? normalizePhone(c.phone) : null,
        notes: input.notes ?? null,
        ...totals,
        totalCents,
        paymentStatus: input.payment.status,
        paymentProvider: input.payment.provider ?? null,
        paymentRef: input.payment.reference ?? null,
        tender: input.payment.tender ?? null,
        placedAt,
        completedAt: initialStatus === "completed" ? placedAt : null,
        actorId,
        raw: input.raw ?? null,
      })
      .returning();

    await tx.insert(orderItems).values(
      lines.map((l) => ({
        orderId: order.id,
        itemId: l.itemId,
        sku: l.sku,
        name: l.name,
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
        modifiers: l.modifiers,
        notes: l.notes,
        station: l.station,
        lineTotalCents: l.lineTotalCents,
      })),
    );
    await tx.insert(orderEvents).values({ orderId: order.id, status: initialStatus, actorId, note: `via ${input.channel}` });
    if (promo?.ok) await recordPromoRedemption(promo.promotion.id, order.id, customerId, promo.discountCents, tx);
    if (pointsToRedeem > 0 && customerId) await redeemForOrder(order.id, customerId, pointsToRedeem, actorId, tx);
    if (initialStatus === "completed") await earnForOrder(order.id, tx);

    // Auto-deplete stock by recipe (append-only ledger).
    for (const l of lines) {
      for (const r of l.recipe) {
        const delta = -(r.qty * l.qty);
        const [cur] = await tx.select().from(stockLevels).where(and(eq(stockLevels.locationId, loc.id), eq(stockLevels.ingredientId, r.ingredientId)));
        const after = Number(cur?.qty ?? 0) + delta;
        await tx
          .insert(stockLevels)
          .values({ locationId: loc.id, ingredientId: r.ingredientId, qty: String(after), parLevel: "0", updatedAt: new Date() })
          .onConflictDoUpdate({ target: [stockLevels.locationId, stockLevels.ingredientId], set: { qty: String(after), updatedAt: new Date() } });
        await tx.insert(stockMovements).values({ locationId: loc.id, ingredientId: r.ingredientId, kind: "sale", deltaQty: String(delta), resultingQty: String(after), note: `order #${order.number}`, actorId });
      }
    }

    await bumpDailyFact(tx, loc.id, day, { ordersCount: 1, grossCents: totals.subtotalCents - totals.discountCents, gstCents: totals.gstCents, pstCents: totals.pstCents, tipsCents: totals.tipCents, commissionCents: totals.commissionCents, channel: input.channel });
    return order;
  });

  await enqueueWebhooks(loc.brandId, `order.${initialStatus}`, { order_id: result.id, external_id: result.externalId, channel: result.channel, status: result.status, number: result.number, location_id: loc.id });
  return { order: result, created: true as const };
}

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  received: ["accepted", "cancelled"],
  accepted: ["preparing", "ready", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: ["refunded"],
  cancelled: [],
  refunded: [],
};

export async function transitionOrder(orderId: string, to: OrderStatus, actorId: string | null, note?: string, readyBy?: Date) {
  const order = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, orderId) });
  if (!order) throw new Error("Order not found");
  if (!TRANSITIONS[order.status].includes(to)) throw new Error(`Cannot go from ${order.status} to ${to}`);
  const patch: Partial<typeof orders.$inferInsert> = { status: to };
  if (to === "completed") patch.completedAt = new Date();
  if (to === "refunded") patch.paymentStatus = "refunded";
  if (readyBy) patch.readyBy = readyBy;
  await db.transaction(async (tx) => {
    await tx.update(orders).set(patch).where(eq(orders.id, orderId));
    await tx.insert(orderEvents).values({ orderId, status: to, actorId, note: note ?? null });
    if (to === "completed") await earnForOrder(orderId, tx);
    if (to === "refunded" || (to === "cancelled" && order.status === "completed")) await reverseForOrder(orderId, tx);
    if (to === "cancelled" || to === "refunded") {
      const day = fmtDate(order.placedAt);
      await bumpDailyFact(tx, order.locationId, day, { ordersCount: -1, grossCents: -(order.subtotalCents - order.discountCents), gstCents: -order.gstCents, pstCents: -order.pstCents, tipsCents: -order.tipCents, commissionCents: -order.commissionCents, channel: order.channel });
    }
  });
  await enqueueWebhooks(order.brandId, `order.${to}`, { order_id: orderId, external_id: order.externalId, channel: order.channel, status: to, number: order.number, location_id: order.locationId, ready_by: readyBy?.toISOString() ?? null, note: note ?? null });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function bumpDailyFact(tx: Tx, locationId: string, day: string, d: { ordersCount: number; grossCents: number; gstCents: number; pstCents: number; tipsCents: number; commissionCents: number; channel: string }) {
  const [cur] = await tx.select().from(factSalesDaily).where(and(eq(factSalesDaily.locationId, locationId), eq(factSalesDaily.day, day)));
  const by = { ...(cur?.byChannel ?? {}) };
  const ch = by[d.channel] ?? { orders: 0, grossCents: 0 };
  by[d.channel] = { orders: ch.orders + d.ordersCount, grossCents: ch.grossCents + d.grossCents };
  await tx
    .insert(factSalesDaily)
    .values({ locationId, day, ordersCount: d.ordersCount, grossCents: d.grossCents, gstCents: d.gstCents, pstCents: d.pstCents, tipsCents: d.tipsCents, commissionCents: d.commissionCents, byChannel: by, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [factSalesDaily.locationId, factSalesDaily.day],
      set: {
        ordersCount: sql`${factSalesDaily.ordersCount} + ${d.ordersCount}`,
        grossCents: sql`${factSalesDaily.grossCents} + ${d.grossCents}`,
        gstCents: sql`${factSalesDaily.gstCents} + ${d.gstCents}`,
        pstCents: sql`${factSalesDaily.pstCents} + ${d.pstCents}`,
        tipsCents: sql`${factSalesDaily.tipsCents} + ${d.tipsCents}`,
        commissionCents: sql`${factSalesDaily.commissionCents} + ${d.commissionCents}`,
        byChannel: by,
        updatedAt: new Date(),
      },
    });
}

/** Rebuild fact rows for a location over a date range from the orders table (after imports). */
export async function rebuildFacts(locationId: string, from: Date, to: Date) {
  const rows = await db.select().from(orders).where(and(eq(orders.locationId, locationId), gte(orders.placedAt, from), lte(orders.placedAt, to)));
  const byDay = new Map<string, typeof factSalesDaily.$inferInsert>();
  for (const o of rows) {
    if (o.status === "cancelled" || o.status === "refunded") continue;
    const day = fmtDate(o.placedAt);
    const f = byDay.get(day) ?? { locationId, day, ordersCount: 0, grossCents: 0, gstCents: 0, pstCents: 0, tipsCents: 0, commissionCents: 0, byChannel: {} };
    f.ordersCount! += 1;
    f.grossCents! += o.subtotalCents - o.discountCents;
    f.gstCents! += o.gstCents;
    f.pstCents! += o.pstCents;
    f.tipsCents! += o.tipCents;
    f.commissionCents! += o.commissionCents;
    const by = f.byChannel as Record<string, { orders: number; grossCents: number }>;
    const ch = by[o.channel] ?? { orders: 0, grossCents: 0 };
    by[o.channel] = { orders: ch.orders + 1, grossCents: ch.grossCents + (o.subtotalCents - o.discountCents) };
    byDay.set(day, f);
  }
  for (const f of byDay.values()) {
    await db.insert(factSalesDaily).values({ ...f, updatedAt: new Date() }).onConflictDoUpdate({ target: [factSalesDaily.locationId, factSalesDaily.day], set: { ...f, updatedAt: new Date() } });
  }
}

export function normalizePhone(p: string) {
  const digits = p.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return p.startsWith("+") ? p : `+${digits}`;
}

export const ORDER_TRANSITIONS = TRANSITIONS;
