import { json } from "@/lib/api-auth";
import { authenticateStaff } from "@/lib/staff-auth";
import { db } from "@/db";
export const dynamic = "force-dynamic";

/** GET /api/v1/staff/shifts?from=ISO&to=ISO → my published shifts (default: today → +14 days). */
export async function GET(req: Request) {
  const a = await authenticateStaff(req, "");
  if (a instanceof Response) return a;
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : new Date(new Date().setHours(0, 0, 0, 0));
  const to = url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : new Date(from.getTime() + 14 * 86400000);
  const rows = await db.query.shifts.findMany({
    where: (s, { and, eq, gte, lte, inArray }) => and(eq(s.userId, a.viewer.id), gte(s.startsAt, from), lte(s.startsAt, to), inArray(s.status, ["published", "open"])),
    with: { location: true },
    orderBy: (s, { asc }) => asc(s.startsAt),
  });
  return json({ shifts: rows.map((s) => ({ id: s.id, location_id: s.locationId, location_name: s.location.name, position: s.position, starts_at: s.startsAt, ends_at: s.endsAt, break_min: s.breakMin, notes: s.notes, status: s.status })) });
}
