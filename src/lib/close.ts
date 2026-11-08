import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { brands, cashDrawerSessions, dailyCloses, employeeProfiles, locations, orders, timeEntries, users, type DailyClose } from "@/db/schema";
import { paidHours } from "./dates";

/** [start, end) of a store-local day as UTC instants. */
export function dayBounds(day: string, timezone: string) {
  // Compute offset for that date in the store timezone (handles DST).
  const probe = new Date(`${day}T12:00:00Z`);
  const local = new Date(probe.toLocaleString("en-US", { timeZone: timezone }));
  const offsetMin = (probe.getTime() - local.getTime()) / 60000;
  const start = new Date(new Date(`${day}T00:00:00Z`).getTime() + offsetMin * 60000);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}

export type ZReport = Omit<DailyClose, "closedBy" | "closedAt" | "exportedAt" | "note"> & { drawer: typeof cashDrawerSessions.$inferSelect | null; locked: boolean };

/** Compute the Z-report for a store/day from orders + time entries. Does not write. */
export async function computeZ(locationId: string, day: string): Promise<ZReport> {
  const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
  const { start, end } = dayBounds(day, loc.timezone);
  const rows = await db.select().from(orders).where(and(eq(orders.locationId, locationId), gte(orders.placedAt, start), lt(orders.placedAt, end)));
  const z: ZReport = {
    locationId, day, ordersCount: 0, grossCents: 0, discountCents: 0, netCents: 0, gstCents: 0, pstCents: 0, tipsCents: 0, feesCents: 0, commissionCents: 0, refundsCents: 0,
    byTender: {}, byChannel: {}, cashExpectedCents: 0, cashCountedCents: 0, cashVarianceCents: 0, tipAllocations: [], labourCents: 0, labourHours: "0", drawer: null, locked: false,
  };
  for (const o of rows) {
    if (o.status === "cancelled") continue;
    if (o.status === "refunded") { z.refundsCents += o.totalCents; continue; }
    z.ordersCount += 1;
    z.grossCents += o.subtotalCents;
    z.discountCents += o.discountCents;
    z.netCents += o.subtotalCents - o.discountCents;
    z.gstCents += o.gstCents;
    z.pstCents += o.pstCents;
    z.tipsCents += o.tipCents;
    z.feesCents += o.feeCents;
    z.commissionCents += o.commissionCents;
    const isAgg = o.channel === "uber_eats" || o.channel === "doordash" || o.channel === "skip";
    const tender = isAgg ? "aggregator" : (o.tender === "online" ? "card" : o.tender) ?? o.paymentProvider ?? "unknown";
    z.byTender[tender] = (z.byTender[tender] ?? 0) + o.totalCents;
    const ch = z.byChannel[o.channel] ?? { orders: 0, grossCents: 0 };
    z.byChannel[o.channel] = { orders: ch.orders + 1, grossCents: ch.grossCents + (o.subtotalCents - o.discountCents) };
  }

  const [drawer] = await db.select().from(cashDrawerSessions).where(and(eq(cashDrawerSessions.locationId, locationId), eq(cashDrawerSessions.day, day))).orderBy(sql`${cashDrawerSessions.openedAt} desc`).limit(1);
  z.drawer = drawer ?? null;
  const cashSales = z.byTender.cash ?? 0;
  z.cashExpectedCents = (drawer?.openingFloatCents ?? 0) + cashSales - (drawer?.paidOutCents ?? 0);
  z.cashCountedCents = drawer?.countedCents ?? 0;
  z.cashVarianceCents = drawer?.countedCents != null ? drawer.countedCents - z.cashExpectedCents : 0;

  // Tip pool by hours worked that day (BC: employer may pool, may not keep a share).
  const entries = await db
    .select({ e: timeEntries, name: users.name, rate: employeeProfiles.hourlyRateCents })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
    .where(and(eq(timeEntries.locationId, locationId), gte(timeEntries.clockIn, start), lt(timeEntries.clockIn, end)));
  const hoursBy = new Map<string, { name: string; hours: number; rate: number | null }>();
  for (const r of entries) {
    const h = r.e.clockOut ? paidHours(r.e.clockIn, r.e.clockOut, r.e.breakMin) : 0;
    const cur = hoursBy.get(r.e.userId) ?? { name: r.name ?? "Staff", hours: 0, rate: r.rate ?? null };
    cur.hours += h;
    hoursBy.set(r.e.userId, cur);
  }
  const totalHours = [...hoursBy.values()].reduce((a, b) => a + b.hours, 0);
  z.labourHours = totalHours.toFixed(2);
  z.labourCents = [...hoursBy.values()].reduce((a, b) => a + (b.rate ? Math.round(b.rate * b.hours) : 0), 0);
  if (totalHours > 0 && z.tipsCents > 0) {
    let allocated = 0;
    const list = [...hoursBy.entries()].map(([userId, v]) => ({ userId, name: v.name, hours: Number(v.hours.toFixed(2)), cents: Math.floor((z.tipsCents * v.hours) / totalHours) }));
    list.forEach((l) => (allocated += l.cents));
    if (list.length) list[0].cents += z.tipsCents - allocated; // rounding remainder to first
    z.tipAllocations = list;
  }
  const [locked] = await db.select({ day: dailyCloses.day }).from(dailyCloses).where(and(eq(dailyCloses.locationId, locationId), eq(dailyCloses.day, day)));
  z.locked = Boolean(locked);
  return z;
}

/** Lock the day: snapshot the Z-report. Refuses if there are still live orders. */
export async function closeDay(locationId: string, day: string, actorId: string, note?: string) {
  const z = await computeZ(locationId, day);
  const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
  const { start, end } = dayBounds(day, loc.timezone);
  const [{ live }] = await db
    .select({ live: sql<number>`count(*)` })
    .from(orders)
    .where(and(eq(orders.locationId, locationId), gte(orders.placedAt, start), lt(orders.placedAt, end), sql`${orders.status} in ('received','accepted','preparing','ready')`));
  if (Number(live) > 0) throw new Error(`${live} order(s) still open — complete or cancel them before closing the day`);
  const { drawer, locked, ...snapshot } = z;
  void drawer; void locked;
  await db
    .insert(dailyCloses)
    .values({ ...snapshot, closedBy: actorId, closedAt: new Date(), note: note ?? null })
    .onConflictDoUpdate({ target: [dailyCloses.locationId, dailyCloses.day], set: { ...snapshot, closedBy: actorId, closedAt: new Date(), note: note ?? null } });
  return z;
}

/**
 * Accounting journal for a closed day (QuickBooks Online "journal entry" CSV shape).
 * Debits: Cash on hand, Card clearing, Aggregator receivable, Commission expense, Discounts.
 * Credits: Sales, GST payable, PST payable, Tips payable, Platform fees income.
 */
export async function journalFor(locationId: string, day: string) {
  const [close] = await db.select().from(dailyCloses).where(and(eq(dailyCloses.locationId, locationId), eq(dailyCloses.day, day)));
  if (!close) throw new Error("Day not closed yet");
  const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
  const [brand] = await db.select().from(brands).where(eq(brands.id, loc.brandId));
  const lines: Array<{ account: string; debit: number; credit: number; memo: string }> = [];
  const tender = close.byTender;
  const cash = tender.cash ?? 0;
  const aggregator = tender.aggregator ?? 0;
  const card = Object.entries(tender).filter(([k]) => k !== "cash" && k !== "aggregator").reduce((a, [, v]) => a + v, 0);
  if (cash) lines.push({ account: "Cash on Hand", debit: cash, credit: 0, memo: "Cash sales incl. tax & tips" });
  if (card) lines.push({ account: "Card Clearing (Clover/Stripe)", debit: card, credit: 0, memo: "Card/online sales incl. tax & tips" });
  if (aggregator) lines.push({ account: "Accounts Receivable – Delivery Apps", debit: aggregator, credit: 0, memo: "Uber/DoorDash/Skip gross" });
  if (close.commissionCents) {
    lines.push({ account: "Delivery App Commission", debit: close.commissionCents, credit: 0, memo: "Aggregator commission" });
    lines.push({ account: "Accounts Receivable – Delivery Apps", debit: 0, credit: close.commissionCents, memo: "Commission netted by platform" });
  }
  lines.push({ account: "Sales – Food & Beverage", debit: 0, credit: close.netCents, memo: `${close.ordersCount} orders` });
  if (close.gstCents) lines.push({ account: "GST/HST Payable", debit: 0, credit: close.gstCents, memo: "GST collected" });
  if (close.pstCents) lines.push({ account: "PST Payable", debit: 0, credit: close.pstCents, memo: "PST collected" });
  if (close.tipsCents) lines.push({ account: "Tips Payable", debit: 0, credit: close.tipsCents, memo: "Tips owed to staff" });
  if (close.feesCents) lines.push({ account: "Platform Fee Income", debit: 0, credit: close.feesCents, memo: "App Thru order fees" });
  if (close.cashVarianceCents) {
    if (close.cashVarianceCents < 0) lines.push({ account: "Cash Over/Short", debit: -close.cashVarianceCents, credit: 0, memo: "Drawer short" });
    else lines.push({ account: "Cash Over/Short", debit: 0, credit: close.cashVarianceCents, memo: "Drawer over" });
    lines.push({ account: "Cash on Hand", debit: close.cashVarianceCents > 0 ? close.cashVarianceCents : 0, credit: close.cashVarianceCents < 0 ? -close.cashVarianceCents : 0, memo: "Variance adjustment" });
  }
  const royalty = Math.round((close.netCents * Number(brand.royaltyPct)) / 100);
  const adFund = Math.round((close.netCents * Number(brand.adFundPct)) / 100);
  if (royalty) { lines.push({ account: "Franchise Royalty Expense", debit: royalty, credit: 0, memo: `${brand.royaltyPct}% of net` }); lines.push({ account: "Due to Franchisor", debit: 0, credit: royalty, memo: "Royalty accrual" }); }
  if (adFund) { lines.push({ account: "Franchise Ad Fund Expense", debit: adFund, credit: 0, memo: `${brand.adFundPct}% of net` }); lines.push({ account: "Due to Franchisor", debit: 0, credit: adFund, memo: "Ad fund accrual" }); }
  const debit = lines.reduce((a, l) => a + l.debit, 0);
  const credit = lines.reduce((a, l) => a + l.credit, 0);
  return { location: loc, close, lines, balanced: debit === credit, debit, credit };
}

export function journalCsv(j: Awaited<ReturnType<typeof journalFor>>) {
  const date = j.close.day;
  const ref = `${j.location.name.replace(/[^A-Za-z0-9]+/g, "")}-${date}`;
  const head = ["JournalNo", "JournalDate", "Account", "Debit", "Credit", "Memo", "Location"];
  const rows = j.lines.map((l) => [ref, date, l.account, l.debit ? (l.debit / 100).toFixed(2) : "", l.credit ? (l.credit / 100).toFixed(2) : "", l.memo, j.location.name]);
  return [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
}
