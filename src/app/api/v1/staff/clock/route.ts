import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { timeEntries } from "@/db/schema";
import { json } from "@/lib/api-auth";
import { authenticateStaff } from "@/lib/staff-auth";
export const dynamic = "force-dynamic";

/** POST /api/v1/staff/clock {action:"in", location_id, lat?, lng?} | {action:"out", break_min?, tips_cents?} */
export async function POST(req: Request) {
  const raw = await req.text();
  const a = await authenticateStaff(req, raw);
  if (a instanceof Response) return a;
  const p = z.discriminatedUnion("action", [
    z.object({ action: z.literal("in"), location_id: z.string(), lat: z.number().optional(), lng: z.number().optional() }),
    z.object({ action: z.literal("out"), break_min: z.number().int().min(0).max(240).default(0), tips_cents: z.number().int().min(0).default(0) }),
  ]).safeParse(JSON.parse(raw || "{}"));
  if (!p.success) return json({ error: "validation", issues: p.error.issues }, 422);
  const open = await db.query.timeEntries.findFirst({ where: (t, { and, eq, isNull }) => and(eq(t.userId, a.viewer.id), isNull(t.clockOut)) });
  if (p.data.action === "in") {
    const d = p.data;
    if (!a.viewer.locations.some((l) => l.id === d.location_id)) return json({ error: "not your store" }, 403);
    if (open) return json({ error: "already clocked in", time_entry_id: open.id }, 409);
    const now = new Date();
    const shift = await db.query.shifts.findFirst({ where: (s, { and, eq, gte, lte }) => and(eq(s.userId, a.viewer.id), eq(s.locationId, d.location_id), lte(s.startsAt, new Date(now.getTime() + 3600000)), gte(s.endsAt, now)) });
    const [e] = await db.insert(timeEntries).values({ userId: a.viewer.id, locationId: d.location_id, shiftId: shift?.id ?? null, clockIn: now, editNote: d.lat != null ? `gps ${d.lat.toFixed(5)},${d.lng?.toFixed(5)}` : null }).returning();
    return json({ time_entry_id: e.id, clock_in: e.clockIn, shift_id: shift?.id ?? null }, 201);
  }
  if (!open) return json({ error: "not clocked in" }, 409);
  const [e] = await db.update(timeEntries).set({ clockOut: new Date(), breakMin: p.data.break_min, declaredTipsCents: p.data.tips_cents }).where(and(eq(timeEntries.id, open.id), isNull(timeEntries.clockOut))).returning();
  return json({ time_entry_id: e.id, clock_in: e.clockIn, clock_out: e.clockOut, break_min: e.breakMin });
}
