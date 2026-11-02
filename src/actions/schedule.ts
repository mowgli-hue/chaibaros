"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { auditLog, availability, memberships, shiftClaims, shifts, timeEntries, users } from "@/db/schema";
import { assertManage, requireViewer, roleAt } from "@/lib/access";
import { fmtDay, fmtTime, weekRange } from "@/lib/dates";
import { env } from "@/lib/env";
import { sendMail, layout, button } from "@/lib/mail";

const shiftSchema = z.object({
  locationId: z.string(),
  userId: z.string().optional().transform((v) => (v ? v : null)),
  position: z.enum(["barista", "kitchen", "lead"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  breakMin: z.coerce.number().min(0).max(120).default(0),
  notes: z.string().optional(),
});

function toDate(date: string, time: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

export async function createShift(formData: FormData) {
  const viewer = await requireViewer();
  const data = shiftSchema.parse(Object.fromEntries(formData));
  assertManage(viewer, data.locationId);
  const startsAt = toDate(data.date, data.start);
  let endsAt = toDate(data.date, data.end);
  if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + 24 * 3600 * 1000); // overnight
  await db.insert(shifts).values({
    locationId: data.locationId,
    userId: data.userId,
    position: data.position,
    startsAt,
    endsAt,
    breakMin: data.breakMin,
    notes: data.notes,
    status: "draft",
    createdBy: viewer.id,
  });
  revalidatePath("/schedule");
}

export async function deleteShift(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("id"));
  const s = await db.query.shifts.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!s) return;
  assertManage(viewer, s.locationId);
  if (s.status === "draft") await db.delete(shifts).where(eq(shifts.id, id));
  else await db.update(shifts).set({ status: "cancelled" }).where(eq(shifts.id, id));
  await db.insert(auditLog).values({ actorId: viewer.id, locationId: s.locationId, entity: "shift", entityId: id, action: s.status === "draft" ? "delete" : "cancel" });
  revalidatePath("/schedule");
}

export async function assignShift(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("id"));
  const userId = String(formData.get("userId") || "") || null;
  const s = await db.query.shifts.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!s) return;
  assertManage(viewer, s.locationId);
  const status = s.status === "draft" ? "draft" : userId ? "published" : "open";
  await db.update(shifts).set({ userId, status }).where(eq(shifts.id, id));
  revalidatePath("/schedule");
}

/** Publish every draft shift in the week: assigned → published, unassigned → open. Emails each person their shifts. */
export async function publishWeek(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const weekOf = new Date(String(formData.get("weekOf")));
  assertManage(viewer, locationId);
  const { start, end } = weekRange(weekOf);

  const drafts = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.locationId, locationId), eq(shifts.status, "draft"), gte(shifts.startsAt, start), lte(shifts.startsAt, end)));
  if (!drafts.length) return;

  const now = new Date();
  await db.transaction(async (tx) => {
    const assigned = drafts.filter((d) => d.userId).map((d) => d.id);
    const open = drafts.filter((d) => !d.userId).map((d) => d.id);
    if (assigned.length) await tx.update(shifts).set({ status: "published", publishedAt: now }).where(inArray(shifts.id, assigned));
    if (open.length) await tx.update(shifts).set({ status: "open", publishedAt: now }).where(inArray(shifts.id, open));
    await tx.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "schedule", entityId: start.toISOString().slice(0, 10), action: "publish", diff: { shifts: drafts.length } });
  });

  // Notify each person with their shifts for the week.
  const location = viewer.locations.find((l) => l.id === locationId)!;
  const byUser = new Map<string, typeof drafts>();
  drafts.forEach((d) => { if (d.userId) byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d]); });
  const people = byUser.size ? await db.select().from(users).where(inArray(users.id, [...byUser.keys()])) : [];
  await Promise.all(
    people.map((p) => {
      if (!p.email) return;
      const list = byUser.get(p.id)!.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const lines = list.map((s) => `${fmtDay(s.startsAt)} ${fmtTime(s.startsAt)}–${fmtTime(s.endsAt)} (${s.position})`);
      return sendMail({
        to: p.email,
        subject: `Your shifts at ${location.name} · week of ${fmtDay(start)}`,
        text: lines.join("\n"),
        html: layout(`Shifts for the week of ${fmtDay(start)}`, `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>${button(`${env.appUrl}/me`, "Open my shifts")}`),
      });
    }),
  );
  revalidatePath("/schedule");
  revalidatePath("/me");
}

export async function claimShift(formData: FormData) {
  const viewer = await requireViewer();
  const shiftId = String(formData.get("shiftId"));
  const s = await db.query.shifts.findFirst({ where: (t, { eq }) => eq(t.id, shiftId) });
  if (!s || s.status !== "open") return;
  if (!roleAt(viewer, s.locationId)) throw new Error("Not your store");
  await db.insert(shiftClaims).values({ shiftId, userId: viewer.id }).onConflictDoNothing();
  revalidatePath("/me");
  revalidatePath("/schedule");
}

export async function decideClaim(formData: FormData) {
  const viewer = await requireViewer();
  const claimId = String(formData.get("claimId"));
  const decision = z.enum(["approved", "denied"]).parse(formData.get("decision"));
  const claim = await db.query.shiftClaims.findFirst({ where: (c, { eq }) => eq(c.id, claimId), with: { shift: true } });
  if (!claim) return;
  assertManage(viewer, claim.shift.locationId);
  await db.transaction(async (tx) => {
    await tx.update(shiftClaims).set({ status: decision }).where(eq(shiftClaims.id, claimId));
    if (decision === "approved") {
      await tx.update(shifts).set({ userId: claim.userId, status: "published" }).where(eq(shifts.id, claim.shiftId));
      await tx.update(shiftClaims).set({ status: "denied" }).where(and(eq(shiftClaims.shiftId, claim.shiftId), eq(shiftClaims.status, "pending")));
    }
  });
  revalidatePath("/schedule");
  revalidatePath("/me");
}

const availSchema = z.object({ weekday: z.coerce.number().min(0).max(6), start: z.string(), end: z.string() });

export async function addAvailability(formData: FormData) {
  const viewer = await requireViewer();
  const data = availSchema.parse(Object.fromEntries(formData));
  const [sh, sm] = data.start.split(":").map(Number);
  const [eh, em] = data.end.split(":").map(Number);
  await db.insert(availability).values({ userId: viewer.id, weekday: data.weekday, startMin: sh * 60 + sm, endMin: eh * 60 + em });
  revalidatePath("/me");
}

export async function removeAvailability(formData: FormData) {
  const viewer = await requireViewer();
  await db.delete(availability).where(and(eq(availability.id, String(formData.get("id"))), eq(availability.userId, viewer.id)));
  revalidatePath("/me");
}

/** Self clock-in from a signed-in session (phone / Vlink web). */
export async function clockIn(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  if (!roleAt(viewer, locationId)) throw new Error("Not your store");
  const open = await db.query.timeEntries.findFirst({ where: (t, { and, eq, isNull }) => and(eq(t.userId, viewer.id), isNull(t.clockOut)) });
  if (open) return;
  const now = new Date();
  const shift = await db.query.shifts.findFirst({
    where: (s, { and, eq, gte, lte }) => and(eq(s.userId, viewer.id), eq(s.locationId, locationId), lte(s.startsAt, new Date(now.getTime() + 60 * 60000)), gte(s.endsAt, now)),
  });
  await db.insert(timeEntries).values({ userId: viewer.id, locationId, shiftId: shift?.id ?? null, clockIn: now });
  revalidatePath("/me");
}

export async function clockOut(formData: FormData) {
  const viewer = await requireViewer();
  const breakMin = Number(formData.get("breakMin") ?? 0);
  const tips = Math.round(Number(formData.get("tips") ?? 0) * 100);
  await db
    .update(timeEntries)
    .set({ clockOut: new Date(), breakMin, declaredTipsCents: tips })
    .where(and(eq(timeEntries.userId, viewer.id), isNull(timeEntries.clockOut)));
  revalidatePath("/me");
}

/** Shared store device: a manager is signed in; staff punch with their PIN. */
export async function pinPunch(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const pin = String(formData.get("pin"));
  if (!roleAt(viewer, locationId)) throw new Error("Not your store");
  const members = await db
    .select({ id: users.id, pinHash: users.pinHash, name: users.name, active: users.active })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.locationId, locationId));
  let who: { id: string; name: string | null } | null = null;
  for (const m of members) {
    if (m.active && m.pinHash && (await bcrypt.compare(pin, m.pinHash))) { who = m; break; }
  }
  if (!who) throw new Error("PIN not recognised");
  const open = await db.query.timeEntries.findFirst({ where: (t, { and, eq, isNull }) => and(eq(t.userId, who!.id), isNull(t.clockOut)) });
  if (open) {
    await db.update(timeEntries).set({ clockOut: new Date() }).where(eq(timeEntries.id, open.id));
  } else {
    await db.insert(timeEntries).values({ userId: who.id, locationId, clockIn: new Date() });
  }
  revalidatePath("/schedule");
  revalidatePath("/timesheets");
}

export async function editTimeEntry(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("id"));
  const entry = await db.query.timeEntries.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!entry) return;
  assertManage(viewer, entry.locationId);
  const clockIn = new Date(String(formData.get("clockIn")));
  const clockOutRaw = String(formData.get("clockOut") ?? "");
  const clockOut = clockOutRaw ? new Date(clockOutRaw) : null;
  const breakMin = Number(formData.get("breakMin") ?? 0);
  const tips = Math.round(Number(formData.get("tips") ?? 0) * 100);
  const editNote = String(formData.get("editNote") ?? "");
  await db.update(timeEntries).set({ clockIn, clockOut, breakMin, declaredTipsCents: tips, editedBy: viewer.id, editNote }).where(eq(timeEntries.id, id));
  await db.insert(auditLog).values({ actorId: viewer.id, locationId: entry.locationId, entity: "time_entry", entityId: id, action: "edit", diff: { from: { clockIn: entry.clockIn, clockOut: entry.clockOut, breakMin: entry.breakMin }, to: { clockIn, clockOut, breakMin }, editNote } });
  revalidatePath("/timesheets");
}
