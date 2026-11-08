import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { availability } from "@/db/schema";
import { json } from "@/lib/api-auth";
import { authenticateStaff } from "@/lib/staff-auth";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await authenticateStaff(req, "");
  if (a instanceof Response) return a;
  const rows = await db.select().from(availability).where(eq(availability.userId, a.viewer.id));
  return json({ availability: rows.map((r) => ({ id: r.id, weekday: r.weekday, start_min: r.startMin, end_min: r.endMin, note: r.note })) });
}

/** PUT replaces the whole weekly availability: [{weekday, start_min, end_min}] */
export async function PUT(req: Request) {
  const raw = await req.text();
  const a = await authenticateStaff(req, raw);
  if (a instanceof Response) return a;
  const p = z.object({ availability: z.array(z.object({ weekday: z.number().int().min(0).max(6), start_min: z.number().int().min(0).max(1440), end_min: z.number().int().min(0).max(1440), note: z.string().optional() })) }).safeParse(JSON.parse(raw || "{}"));
  if (!p.success) return json({ error: "validation", issues: p.error.issues }, 422);
  await db.transaction(async (tx) => {
    await tx.delete(availability).where(eq(availability.userId, a.viewer.id));
    if (p.data.availability.length) await tx.insert(availability).values(p.data.availability.map((r) => ({ userId: a.viewer.id, weekday: r.weekday, startMin: r.start_min, endMin: r.end_min, note: r.note ?? null })));
  });
  return json({ ok: true, count: p.data.availability.length });
}
