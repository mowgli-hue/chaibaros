"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, loyaltyPrograms, promotions } from "@/db/schema";
import { requireViewer } from "@/lib/access";
import { adjustPoints, ensureAccount } from "@/lib/loyalty";

function assertBrandAdmin(viewer: Awaited<ReturnType<typeof requireViewer>>, brandId: string) {
  if (viewer.brandIds.includes(brandId)) return;
  if (viewer.isOwner && viewer.locations.some((l) => l.brandId === brandId)) return;
  throw new Error("Owner or franchisor required");
}

export async function saveProgram(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  assertBrandAdmin(viewer, brandId);
  const d = z
    .object({ name: z.string().min(1), active: z.boolean(), pointsPerDollar: z.coerce.number().int().min(0), redeemCentsPerPoint: z.coerce.number().int().min(1), minRedeemPoints: z.coerce.number().int().min(0), maxRedeemPctOfOrder: z.coerce.number().int().min(0).max(100), signupBonusPoints: z.coerce.number().int().min(0), birthdayBonusPoints: z.coerce.number().int().min(0) })
    .parse({ ...Object.fromEntries(formData), active: formData.get("active") === "on" });
  const earnOnChannels = formData.getAll("earnOnChannels").map(String);
  await db.insert(loyaltyPrograms).values({ brandId, ...d, earnOnChannels, updatedAt: new Date() }).onConflictDoUpdate({ target: loyaltyPrograms.brandId, set: { ...d, earnOnChannels, updatedAt: new Date() } });
  await db.insert(auditLog).values({ actorId: viewer.id, entity: "loyalty_program", entityId: brandId, action: "update", diff: d });
  revalidatePath("/loyalty");
}

export async function upsertPromo(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  assertBrandAdmin(viewer, brandId);
  const id = String(formData.get("id") ?? "");
  const d = z
    .object({ code: z.string().min(2), name: z.string().min(1), kind: z.enum(["percent", "amount", "free_item"]), value: z.coerce.number().min(0), freeItemSku: z.string().optional(), minSubtotal: z.coerce.number().min(0).default(0), firstOrderOnly: z.boolean(), oncePerCustomer: z.boolean(), startsAt: z.string().optional(), endsAt: z.string().optional(), maxRedemptions: z.string().optional() })
    .parse({ ...Object.fromEntries(formData), firstOrderOnly: formData.get("firstOrderOnly") === "on", oncePerCustomer: formData.get("oncePerCustomer") === "on" });
  const values = {
    code: d.code.toUpperCase().trim(),
    name: d.name,
    kind: d.kind,
    value: d.kind === "amount" ? Math.round(d.value * 100) : Math.round(d.value),
    freeItemSku: d.freeItemSku || null,
    minSubtotalCents: Math.round(d.minSubtotal * 100),
    channels: formData.getAll("channels").map(String),
    locationIds: formData.getAll("locationIds").map(String),
    firstOrderOnly: d.firstOrderOnly,
    oncePerCustomer: d.oncePerCustomer,
    startsAt: d.startsAt ? new Date(d.startsAt) : null,
    endsAt: d.endsAt ? new Date(d.endsAt) : null,
    maxRedemptions: d.maxRedemptions ? Number(d.maxRedemptions) : null,
  };
  if (id) await db.update(promotions).set(values).where(eq(promotions.id, id));
  else await db.insert(promotions).values({ brandId, ...values });
  revalidatePath("/loyalty");
}

export async function togglePromo(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("id"));
  const p = await db.query.promotions.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!p) return;
  assertBrandAdmin(viewer, p.brandId);
  await db.update(promotions).set({ active: !p.active }).where(eq(promotions.id, id));
  revalidatePath("/loyalty");
}

export async function manualPoints(formData: FormData) {
  const viewer = await requireViewer();
  const customerId = String(formData.get("customerId"));
  const brandId = String(formData.get("brandId"));
  assertBrandAdmin(viewer, brandId);
  const delta = Number(formData.get("delta"));
  const note = String(formData.get("note") ?? "manual adjustment");
  await ensureAccount(customerId, brandId);
  await adjustPoints(customerId, delta, note, viewer.id);
  revalidatePath("/customers");
  revalidatePath("/loyalty");
}
