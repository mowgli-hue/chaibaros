"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, orderItems } from "@/db/schema";
import { requireViewer, roleAt } from "@/lib/access";
import { createOrder, transitionOrder } from "@/lib/orders";

export async function setOrderStatus(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("id"));
  const status = z.enum(["accepted", "preparing", "ready", "completed", "cancelled", "refunded"]).parse(formData.get("status"));
  const note = formData.get("note") ? String(formData.get("note")) : undefined;
  const minutes = formData.get("readyMin") ? Number(formData.get("readyMin")) : undefined;
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o || !roleAt(viewer, o.locationId)) throw new Error("Not your store");
  await transitionOrder(id, status, viewer.id, note, minutes ? new Date(Date.now() + minutes * 60000) : undefined);
  revalidatePath("/orders");
}

export async function markItemDone(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("itemId"));
  const line = await db.query.orderItems.findFirst({ where: (i, { eq }) => eq(i.id, id), with: { order: true } });
  if (!line || !roleAt(viewer, line.order.locationId)) throw new Error("Not your store");
  await db.update(orderItems).set({ doneAt: line.doneAt ? null : new Date() }).where(eq(orderItems.id, id));
  revalidatePath("/orders");
}

/** Counter / manual order (POS-lite). Lines come as repeated fields: sku[], qty[]. */
export async function createManualOrder(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  if (!roleAt(viewer, locationId)) throw new Error("Not your store");
  const skus = formData.getAll("sku").map(String);
  const qtys = formData.getAll("qty").map((q) => Number(q) || 0);
  const items = skus.map((sku, i) => ({ sku, qty: qtys[i] ?? 0, modifiers: [] as { name: string; price_cents: number }[] })).filter((l) => l.sku && l.qty > 0);
  if (!items.length) throw new Error("Add at least one item");
  const tender = z.enum(["cash", "card", "other"]).parse(formData.get("tender") ?? "cash");
  const tip = Math.round(Number(formData.get("tip") ?? 0) * 100);
  const discount = Math.round(Number(formData.get("discount") ?? 0) * 100);
  const name = String(formData.get("customerName") ?? "") || undefined;
  const phone = String(formData.get("customerPhone") ?? "") || undefined;
  await createOrder(
    {
      idempotency_key: `counter:${crypto.randomUUID()}`,
      channel: "counter",
      location_id: locationId,
      fulfilment: { type: (formData.get("fulfilment") as "dine_in" | "pickup") || "dine_in" },
      customer: name || phone ? { name, phone } : undefined,
      items,
      totals: { discount_cents: discount, tip_cents: tip, fee_cents: 0, commission_cents: 0 },
      payment: { status: "paid", provider: "manual", tender },
      notes: String(formData.get("notes") ?? "") || undefined,
    },
    viewer.id,
  );
  revalidatePath("/orders");
  revalidatePath("/dashboard");
}
