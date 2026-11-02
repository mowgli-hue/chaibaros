import { and, count, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { certificates, memberships, shifts, stockLevels, timeEntries } from "@/db/schema";
import { weekRange } from "./dates";

export type LocationHealth = {
  locationId: string;
  staff: number;
  shiftsThisWeek: number;
  openShifts: number;
  draftShifts: number;
  clockedInNow: number;
  belowPar: number;
  expiringCerts: number;
  expiredCerts: number;
};

export async function locationHealth(locationIds: string[]): Promise<Record<string, LocationHealth>> {
  const out: Record<string, LocationHealth> = {};
  if (!locationIds.length) return out;
  for (const id of locationIds) {
    out[id] = { locationId: id, staff: 0, shiftsThisWeek: 0, openShifts: 0, draftShifts: 0, clockedInNow: 0, belowPar: 0, expiringCerts: 0, expiredCerts: 0 };
  }
  const { start, end } = weekRange(new Date());
  const in30 = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const now = new Date();

  const staffRows = await db
    .select({ locationId: memberships.locationId, n: count() })
    .from(memberships)
    .where(inArray(memberships.locationId, locationIds))
    .groupBy(memberships.locationId);
  staffRows.forEach((r) => { if (r.locationId) out[r.locationId].staff = r.n; });

  const shiftRows = await db
    .select({ locationId: shifts.locationId, status: shifts.status, n: count() })
    .from(shifts)
    .where(and(inArray(shifts.locationId, locationIds), gte(shifts.startsAt, start), lte(shifts.startsAt, end)))
    .groupBy(shifts.locationId, shifts.status);
  shiftRows.forEach((r) => {
    const h = out[r.locationId];
    if (r.status === "published") h.shiftsThisWeek += r.n;
    if (r.status === "open") { h.openShifts += r.n; h.shiftsThisWeek += r.n; }
    if (r.status === "draft") h.draftShifts += r.n;
  });

  const clocked = await db
    .select({ locationId: timeEntries.locationId, n: count() })
    .from(timeEntries)
    .where(and(inArray(timeEntries.locationId, locationIds), isNull(timeEntries.clockOut)))
    .groupBy(timeEntries.locationId);
  clocked.forEach((r) => { out[r.locationId].clockedInNow = r.n; });

  const par = await db
    .select({ locationId: stockLevels.locationId, n: count() })
    .from(stockLevels)
    .where(and(inArray(stockLevels.locationId, locationIds), sql`${stockLevels.qty} < ${stockLevels.parLevel}`))
    .groupBy(stockLevels.locationId);
  par.forEach((r) => { out[r.locationId].belowPar = r.n; });

  const certs = await db
    .select({ locationId: certificates.locationId, expiresAt: certificates.expiresAt })
    .from(certificates)
    .where(and(inArray(certificates.locationId, locationIds), lte(certificates.expiresAt, in30)));
  certs.forEach((c) => {
    if (!c.locationId || !c.expiresAt) return;
    if (c.expiresAt < now) out[c.locationId].expiredCerts += 1;
    else out[c.locationId].expiringCerts += 1;
  });

  return out;
}

export async function myUpcomingShifts(userId: string, limit = 10) {
  return db.query.shifts.findMany({
    where: (s, { and, eq, gte, inArray }) => and(eq(s.userId, userId), gte(s.endsAt, new Date()), inArray(s.status, ["published", "open"])),
    orderBy: (s, { asc }) => asc(s.startsAt),
    with: { location: true },
    limit,
  });
}

export async function openClockEntry(userId: string) {
  return db.query.timeEntries.findFirst({
    where: (t, { and, eq, isNull }) => and(eq(t.userId, userId), isNull(t.clockOut)),
    with: { location: true },
  });
}

export { eq };
