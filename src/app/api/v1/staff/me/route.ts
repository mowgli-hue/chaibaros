import { json } from "@/lib/api-auth";
import { authenticateStaff } from "@/lib/staff-auth";
import { openClockEntry } from "@/lib/queries";
export const dynamic = "force-dynamic";

/** GET /api/v1/staff/me → profile, stores + role at each, current clock state. */
export async function GET(req: Request) {
  const a = await authenticateStaff(req, "");
  if (a instanceof Response) return a;
  const open = await openClockEntry(a.viewer.id);
  return json({
    user: { id: a.viewer.id, name: a.viewer.name, email: a.viewer.email },
    locations: a.viewer.locations.map((l) => ({ id: l.id, name: l.name, city: l.city, timezone: l.timezone, role: l.role, status: l.status })),
    clocked_in: open ? { time_entry_id: open.id, location_id: open.locationId, location_name: open.location.name, clock_in: open.clockIn } : null,
  });
}
