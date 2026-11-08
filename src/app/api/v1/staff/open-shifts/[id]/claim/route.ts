import { db } from "@/db";
import { shiftClaims } from "@/db/schema";
import { json } from "@/lib/api-auth";
import { authenticateStaff } from "@/lib/staff-auth";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = await req.text();
  const a = await authenticateStaff(req, raw);
  if (a instanceof Response) return a;
  const { id } = await ctx.params;
  const s = await db.query.shifts.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!s || s.status !== "open" || !a.viewer.locations.some((l) => l.id === s.locationId)) return json({ error: "shift not claimable" }, 404);
  await db.insert(shiftClaims).values({ shiftId: id, userId: a.viewer.id }).onConflictDoNothing();
  return json({ ok: true, status: "pending_manager_approval" }, 201);
}
