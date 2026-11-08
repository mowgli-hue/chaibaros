import { json } from "@/lib/api-auth";
import { authenticateStaff } from "@/lib/staff-auth";
import { locationHealth } from "@/lib/queries";
export const dynamic = "force-dynamic";

/** GET /api/v1/staff/locations → stores I can see with today's numbers (managers get sales; staff get staffing only). */
export async function GET(req: Request) {
  const a = await authenticateStaff(req, "");
  if (a instanceof Response) return a;
  const health = await locationHealth(a.viewer.locations.map((l) => l.id));
  return json({
    locations: a.viewer.locations.map((l) => {
      const h = health[l.id];
      const mgr = ["manager", "owner", "franchisor"].includes(l.role);
      return { id: l.id, name: l.name, role: l.role, live_orders: h.liveOrders, clocked_in_now: h.clockedInNow, open_shifts: h.openShifts, ...(mgr ? { today_net_cents: h.todayGrossCents, today_orders: h.todayOrders, mtd_net_cents: h.mtdGrossCents, below_par: h.belowPar } : {}) };
    }),
  });
}
