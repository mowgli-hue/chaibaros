"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, itemLocationSettings, itemModifierGroups, menuCategories, menuItems, modifierGroups, modifiers } from "@/db/schema";
import { assertFranchisor, assertManage, requireViewer, roleAt, RoleRank } from "@/lib/access";
import { pushAvailability } from "@/lib/clover";

function brandOf(viewer: Awaited<ReturnType<typeof requireViewer>>, locationId: string) {
  const loc = viewer.locations.find((l) => l.id === locationId);
  if (!loc) throw new Error("Unknown location");
  return loc.brandId;
}

/** Brand menu edits: franchisor, or an owner when the brand has no separate franchisor (single-operator brands). */
function assertMenuEditor(viewer: Awaited<ReturnType<typeof requireViewer>>, brandId: string) {
  if (viewer.brandIds.includes(brandId)) return;
  if (viewer.isOwner && viewer.locations.some((l) => l.brandId === brandId)) return;
  throw new Error("Only the franchisor or an owner can edit the brand menu");
}

export async function upsertCategory(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  assertMenuEditor(viewer, brandId);
  const id = String(formData.get("id") ?? "");
  const name = z.string().min(1).parse(formData.get("name"));
  const sortOrder = Number(formData.get("sortOrder") ?? 0);
  if (id) await db.update(menuCategories).set({ name, sortOrder }).where(eq(menuCategories.id, id));
  else await db.insert(menuCategories).values({ brandId, name, sortOrder });
  revalidatePath("/menu");
}

const itemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.coerce.number().min(0),
  taxClass: z.enum(["gst_only", "gst_pst", "exempt"]),
  station: z.enum(["bar", "kitchen", "packing"]),
  categoryId: z.string().optional(),
  sortOrder: z.coerce.number().default(0),
});

export async function upsertItem(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  assertMenuEditor(viewer, brandId);
  const id = String(formData.get("id") ?? "");
  const d = itemSchema.parse({ ...Object.fromEntries(formData), categoryId: formData.get("categoryId") || undefined });
  const groupIds = formData.getAll("groupIds").map(String);
  const values = { sku: d.sku.toUpperCase(), name: d.name, description: d.description || null, priceCents: Math.round(d.price * 100), taxClass: d.taxClass, station: d.station, categoryId: d.categoryId ?? null, sortOrder: d.sortOrder };
  await db.transaction(async (tx) => {
    let itemId = id;
    if (id) await tx.update(menuItems).set(values).where(eq(menuItems.id, id));
    else itemId = (await tx.insert(menuItems).values({ brandId, ...values }).returning())[0].id;
    await tx.delete(itemModifierGroups).where(eq(itemModifierGroups.itemId, itemId));
    if (groupIds.length) await tx.insert(itemModifierGroups).values(groupIds.map((groupId) => ({ itemId, groupId })));
    await tx.insert(auditLog).values({ actorId: viewer.id, entity: "menu_item", entityId: itemId, action: id ? "update" : "create", diff: values });
  });
  revalidatePath("/menu");
}

export async function archiveItem(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  assertMenuEditor(viewer, brandId);
  await db.update(menuItems).set({ active: false }).where(eq(menuItems.id, String(formData.get("id"))));
  revalidatePath("/menu");
}

export async function upsertModifierGroup(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  assertMenuEditor(viewer, brandId);
  const id = String(formData.get("id") ?? "");
  const name = z.string().min(1).parse(formData.get("name"));
  const minSelect = Number(formData.get("minSelect") ?? 0);
  const maxSelect = Number(formData.get("maxSelect") ?? 1);
  // Modifiers as "Name=price" lines
  const lines = String(formData.get("modifiers") ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  await db.transaction(async (tx) => {
    let gid = id;
    if (id) await tx.update(modifierGroups).set({ name, minSelect, maxSelect }).where(eq(modifierGroups.id, id));
    else gid = (await tx.insert(modifierGroups).values({ brandId, name, minSelect, maxSelect }).returning())[0].id;
    const existing = await tx.select().from(modifiers).where(eq(modifiers.groupId, gid));
    const seen = new Set<string>();
    for (const [i, line] of lines.entries()) {
      const [n, p] = line.split("=").map((s) => s.trim());
      const sku = `${name}-${n}`.toUpperCase().replace(/[^A-Z0-9]+/g, "-");
      seen.add(sku);
      const priceCents = Math.round(Number(p ?? 0) * 100) || 0;
      const ex = existing.find((m) => m.sku === sku);
      if (ex) await tx.update(modifiers).set({ name: n, priceCents, sortOrder: i, active: true }).where(eq(modifiers.id, ex.id));
      else await tx.insert(modifiers).values({ groupId: gid, sku, name: n, priceCents, sortOrder: i });
    }
    for (const m of existing) if (!seen.has(m.sku)) await tx.update(modifiers).set({ active: false }).where(eq(modifiers.id, m.id));
  });
  revalidatePath("/menu");
}

/** Store-level: sold-out toggle (shift lead+), price override (manager+). Mirrors to Clover when linked. */
export async function setStoreItem(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const itemId = String(formData.get("itemId"));
  const role = roleAt(viewer, locationId);
  if (!role || RoleRank[role] < RoleRank.shift_lead) throw new Error("Shift lead or above");
  const action = String(formData.get("action"));
  const cur = await db.query.itemLocationSettings.findFirst({ where: (s, { and, eq }) => and(eq(s.locationId, locationId), eq(s.itemId, itemId)) });
  if (action === "toggle") {
    const available = cur ? !cur.available : false;
    await db
      .insert(itemLocationSettings)
      .values({ locationId, itemId, available, soldOutUntil: null, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [itemLocationSettings.locationId, itemLocationSettings.itemId], set: { available, soldOutUntil: null, updatedAt: new Date() } });
    await db.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "item_availability", entityId: itemId, action: available ? "available" : "sold_out" });
    void pushAvailability(locationId, itemId, available);
  } else if (action === "price") {
    assertManage(viewer, locationId);
    const price = formData.get("price") ? Math.round(Number(formData.get("price")) * 100) : null;
    await db
      .insert(itemLocationSettings)
      .values({ locationId, itemId, priceCents: price, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [itemLocationSettings.locationId, itemLocationSettings.itemId], set: { priceCents: price, updatedAt: new Date() } });
  } else if (action === "channels") {
    assertManage(viewer, locationId);
    const hidden = formData.getAll("hidden").map(String);
    await db
      .insert(itemLocationSettings)
      .values({ locationId, itemId, hiddenChannels: hidden, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [itemLocationSettings.locationId, itemLocationSettings.itemId], set: { hiddenChannels: hidden, updatedAt: new Date() } });
  }
  revalidatePath("/menu");
  revalidatePath("/orders");
}

export async function setRecipe(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  const itemId = String(formData.get("itemId"));
  const locationId = String(formData.get("locationId"));
  // Recipes reference org ingredients; allow managers of a store in the brand.
  assertManage(viewer, locationId);
  void brandOf(viewer, locationId); void assertFranchisor; void brandId; void and;
  const ids = formData.getAll("ingredientId").map(String);
  const qtys = formData.getAll("recipeQty").map((q) => Number(q) || 0);
  const recipe = ids.map((ingredientId, i) => ({ ingredientId, qty: qtys[i] })).filter((r) => r.ingredientId && r.qty > 0);
  await db.update(menuItems).set({ recipe }).where(eq(menuItems.id, itemId));
  revalidatePath("/menu");
}
