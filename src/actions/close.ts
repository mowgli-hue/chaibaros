"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, cashDrawerSessions, dailyCloses } from "@/db/schema";
import { assertManage, requireViewer, roleAt, RoleRank } from "@/lib/access";
import { closeDay } from "@/lib/close";

export async function openDrawer(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const day = String(formData.get("day"));
  const role = roleAt(viewer, locationId);
  if (!role || RoleRank[role] < RoleRank.shift_lead) throw new Error("Shift lead or above");
  const floatCents = Math.round(Number(formData.get("float") ?? 0) * 100);
  await db.insert(cashDrawerSessions).values({ locationId, day, openedBy: viewer.id, openingFloatCents: floatCents });
  await db.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "cash_drawer", entityId: day, action: "open", diff: { floatCents } });
  revalidatePath("/close");
}

export async function countDrawer(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("id"));
  const d = await db.query.cashDrawerSessions.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!d) return;
  const role = roleAt(viewer, d.locationId);
  if (!role || RoleRank[role] < RoleRank.shift_lead) throw new Error("Shift lead or above");
  const countedCents = Math.round(Number(formData.get("counted") ?? 0) * 100);
  const paidOutCents = Math.round(Number(formData.get("paidOut") ?? 0) * 100);
  const paidOutNote = String(formData.get("paidOutNote") ?? "");
  const depositCents = Math.round(Number(formData.get("deposit") ?? 0) * 100);
  const note = String(formData.get("note") ?? "");
  await db.update(cashDrawerSessions).set({ countedCents, paidOutCents, paidOutNote, depositCents, note, closedBy: viewer.id, closedAt: new Date() }).where(eq(cashDrawerSessions.id, id));
  await db.insert(auditLog).values({ actorId: viewer.id, locationId: d.locationId, entity: "cash_drawer", entityId: d.day, action: "count", diff: { countedCents, paidOutCents, depositCents } });
  revalidatePath("/close");
}

export async function lockDay(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const day = String(formData.get("day"));
  assertManage(viewer, locationId);
  await closeDay(locationId, day, viewer.id, String(formData.get("note") ?? "") || undefined);
  await db.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "daily_close", entityId: day, action: "lock" });
  revalidatePath("/close");
  revalidatePath("/dashboard");
}

export async function reopenDay(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const day = String(formData.get("day"));
  assertManage(viewer, locationId);
  if (!viewer.isOwner && !viewer.isFranchisor) throw new Error("Owner required to reopen a closed day");
  await db.delete(dailyCloses).where(and(eq(dailyCloses.locationId, locationId), eq(dailyCloses.day, day)));
  await db.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "daily_close", entityId: day, action: "reopen" });
  revalidatePath("/close");
}
