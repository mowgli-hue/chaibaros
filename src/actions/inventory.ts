"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, ingredients, stockLevels, stockMovements, suppliers } from "@/db/schema";
import { assertManage, requireViewer, roleAt, RoleRank } from "@/lib/access";

function orgOf(viewer: Awaited<ReturnType<typeof requireViewer>>, locationId: string) {
  const loc = viewer.locations.find((l) => l.id === locationId);
  if (!loc) throw new Error("Unknown location");
  return loc.organizationId;
}

export async function createIngredient(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  assertManage(viewer, locationId);
  const organizationId = orgOf(viewer, locationId);
  const data = z
    .object({ name: z.string().min(1), category: z.string().min(1), unit: z.string().min(1), cost: z.coerce.number().min(0).optional(), par: z.coerce.number().min(0).default(0), supplierId: z.string().optional() })
    .parse({ name: formData.get("name"), category: formData.get("category") || "General", unit: formData.get("unit") || "ea", cost: formData.get("cost") || undefined, par: formData.get("par") || 0, supplierId: formData.get("supplierId") || undefined });
  await db.transaction(async (tx) => {
    const [ing] = await tx.insert(ingredients).values({ organizationId, name: data.name, category: data.category, unit: data.unit, costCentsPerUnit: data.cost != null ? Math.round(data.cost * 100) : null, supplierId: data.supplierId ?? null }).returning();
    // Create a stock row for every store in the org so the catalogue is shared.
    const orgLocs = viewer.locations.filter((l) => l.organizationId === organizationId);
    for (const l of orgLocs) {
      await tx.insert(stockLevels).values({ locationId: l.id, ingredientId: ing.id, qty: "0", parLevel: l.id === locationId ? String(data.par) : "0" }).onConflictDoNothing();
    }
  });
  revalidatePath("/inventory");
}

export async function createSupplier(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  assertManage(viewer, locationId);
  await db.insert(suppliers).values({ organizationId: orgOf(viewer, locationId), name: String(formData.get("name")), contact: String(formData.get("contact") ?? ""), phone: String(formData.get("phone") ?? ""), email: String(formData.get("email") ?? "") });
  revalidatePath("/inventory");
}

export async function setPar(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const ingredientId = String(formData.get("ingredientId"));
  assertManage(viewer, locationId);
  const par = Number(formData.get("par"));
  await db.update(stockLevels).set({ parLevel: String(par), updatedAt: new Date() }).where(and(eq(stockLevels.locationId, locationId), eq(stockLevels.ingredientId, ingredientId)));
  revalidatePath("/inventory");
}

/** Record a movement; "count" sets the level, the others add a delta. Shift leads may count and log waste. */
export async function recordMovement(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const ingredientId = String(formData.get("ingredientId"));
  const kind = z.enum(["count", "receive", "waste", "adjust"]).parse(formData.get("kind"));
  const qty = Number(formData.get("qty"));
  const note = String(formData.get("note") ?? "");
  const role = roleAt(viewer, locationId);
  if (!role || RoleRank[role] < RoleRank.shift_lead) throw new Error("Shift lead or above");
  if (Number.isNaN(qty)) throw new Error("Quantity required");

  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(stockLevels).where(and(eq(stockLevels.locationId, locationId), eq(stockLevels.ingredientId, ingredientId))).for("update");
    const before = Number(cur?.qty ?? 0);
    let after: number;
    let delta: number;
    if (kind === "count") { after = qty; delta = qty - before; }
    else if (kind === "waste") { delta = -Math.abs(qty); after = before + delta; }
    else { delta = qty; after = before + delta; }
    const [ing] = await tx.select().from(ingredients).where(eq(ingredients.id, ingredientId));
    const costCents = ing?.costCentsPerUnit != null ? Math.round(Math.abs(delta) * ing.costCentsPerUnit) : null;
    await tx
      .insert(stockLevels)
      .values({ locationId, ingredientId, qty: String(after), parLevel: "0", lastCountedAt: kind === "count" ? new Date() : null, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [stockLevels.locationId, stockLevels.ingredientId], set: { qty: String(after), updatedAt: new Date(), ...(kind === "count" ? { lastCountedAt: new Date() } : {}) } });
    await tx.insert(stockMovements).values({ locationId, ingredientId, kind, deltaQty: String(delta), resultingQty: String(after), costCents, note, actorId: viewer.id });
  });
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
}

/** Bulk weekly count: one form, many ingredients. Blank fields are skipped. */
export async function bulkCount(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const role = roleAt(viewer, locationId);
  if (!role || RoleRank[role] < RoleRank.shift_lead) throw new Error("Shift lead or above");
  const entries = [...formData.entries()].filter(([k, v]) => k.startsWith("count:") && String(v).trim() !== "");
  await db.transaction(async (tx) => {
    for (const [k, v] of entries) {
      const ingredientId = k.slice(6);
      const qty = Number(v);
      if (Number.isNaN(qty)) continue;
      const [cur] = await tx.select().from(stockLevels).where(and(eq(stockLevels.locationId, locationId), eq(stockLevels.ingredientId, ingredientId)));
      const before = Number(cur?.qty ?? 0);
      await tx.update(stockLevels).set({ qty: String(qty), lastCountedAt: new Date(), updatedAt: new Date() }).where(and(eq(stockLevels.locationId, locationId), eq(stockLevels.ingredientId, ingredientId)));
      await tx.insert(stockMovements).values({ locationId, ingredientId, kind: "count", deltaQty: String(qty - before), resultingQty: String(qty), note: "weekly count", actorId: viewer.id });
    }
    await tx.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "inventory", entityId: locationId, action: "count", diff: { items: entries.length } });
  });
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
}

export async function archiveIngredient(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  assertManage(viewer, locationId);
  await db.update(ingredients).set({ active: false }).where(eq(ingredients.id, String(formData.get("ingredientId"))));
  revalidatePath("/inventory");
}
