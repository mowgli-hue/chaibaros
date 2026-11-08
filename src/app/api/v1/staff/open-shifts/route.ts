import { json } from "@/lib/api-auth";
import { authenticateStaff } from "@/lib/staff-auth";
import { db } from "@/db";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await authenticateStaff(req, "");
  if (a instanceof Response) return a;
  const ids = a.viewer.locations.map((l) => l.id);
  if (!ids.length) return json({ open_shifts: [] });
  const rows = await db.query.shifts.findMany({
    where: (s, { and, eq, gte, inArray }) => and(eq(s.status, "open"), gte(s.startsAt, new Date()), inArray(s.locationId, ids)),
    with: { location: true, claims: true },
    orderBy: (s, { asc }) => asc(s.startsAt),
    limit: 50,
  });
  return json({ open_shifts: rows.map((s) => ({ id: s.id, location_id: s.locationId, location_name: s.location.name, position: s.position, starts_at: s.startsAt, ends_at: s.endsAt, break_min: s.breakMin, claimed_by_me: s.claims.some((c) => c.userId === a.viewer.id && c.status === "pending") })) });
}
