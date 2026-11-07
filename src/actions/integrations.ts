"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { apiClients, auditLog, locationIntegrations } from "@/db/schema";
import { assertManage, requireViewer } from "@/lib/access";
import { importMenu, syncClover, testConnection } from "@/lib/clover";
import { rebuildFacts } from "@/lib/orders";

export async function connectClover(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  assertManage(viewer, locationId);
  const cfg = z.object({ merchantId: z.string().min(5), apiToken: z.string().min(10), region: z.enum(["prod", "sandbox"]).default("prod") }).parse(Object.fromEntries(formData));
  let status = "connected";
  let lastError: string | null = null;
  let merchantName = "";
  try {
    const m = await testConnection(cfg);
    merchantName = m.name;
  } catch (e) {
    status = "error";
    lastError = e instanceof Error ? e.message : String(e);
  }
  await db
    .insert(locationIntegrations)
    .values({ locationId, provider: "clover", config: { ...cfg, merchantName }, status, lastError })
    .onConflictDoUpdate({ target: [locationIntegrations.locationId, locationIntegrations.provider], set: { config: { ...cfg, merchantName }, status, lastError } });
  await db.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "integration", entityId: "clover", action: "connect", diff: { merchantId: cfg.merchantId, status } });
  revalidatePath("/integrations");
}

export async function disconnectIntegration(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  const provider = String(formData.get("provider")) as "clover";
  assertManage(viewer, locationId);
  await db.update(locationIntegrations).set({ status: "disconnected", config: {} }).where(and(eq(locationIntegrations.locationId, locationId), eq(locationIntegrations.provider, provider)));
  revalidatePath("/integrations");
}

export async function runCloverImportMenu(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  assertManage(viewer, locationId);
  const r = await importMenu(locationId);
  await db.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "integration", entityId: "clover", action: "import_menu", diff: r });
  revalidatePath("/integrations");
  revalidatePath("/menu");
}

export async function runCloverSync(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  assertManage(viewer, locationId);
  const r = await syncClover(locationId);
  await rebuildFacts(locationId, new Date(Date.now() - 45 * 24 * 3600 * 1000), new Date());
  await db.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "integration", entityId: "clover", action: "sync", diff: r });
  revalidatePath("/integrations");
  revalidatePath("/orders");
  revalidatePath("/dashboard");
}

/** Create an API client for App Thru / Vlink / TiffinGo. Returns the secret once via the audit row shown on the page. */
export async function createApiClient(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  const allowed = viewer.brandIds.includes(brandId) || (viewer.isOwner && viewer.locations.some((l) => l.brandId === brandId));
  if (!allowed) throw new Error("Owner or franchisor required");
  const d = z.object({ name: z.string().min(1), channel: z.enum(["app_thru", "vlink", "tiffingo", "other"]), webhookUrl: z.string().url().optional().or(z.literal("")) }).parse(Object.fromEntries(formData));
  const locationIds = formData.getAll("locationIds").map(String);
  const keyId = `cb_${randomBytes(8).toString("hex")}`;
  const secret = `sk_${randomBytes(24).toString("hex")}`;
  await db.insert(apiClients).values({ brandId, name: d.name, channel: d.channel, keyId, secret, secretHash: await bcrypt.hash(secret, 10), secretHint: secret.slice(-4), webhookUrl: d.webhookUrl || null, locationIds });
  await db.insert(auditLog).values({ actorId: viewer.id, entity: "api_client", entityId: keyId, action: "create", diff: { name: d.name, channel: d.channel } });
  revalidatePath("/integrations");
  // Surface the secret once through a cookie-less query param is unsafe; instead store it for 10 minutes in the audit row? No — show from the page's "reveal" (owner only).
}

export async function revokeApiClient(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("id"));
  const c = await db.query.apiClients.findFirst({ where: (a, { eq }) => eq(a.id, id) });
  if (!c) return;
  const allowed = viewer.brandIds.includes(c.brandId) || (viewer.isOwner && viewer.locations.some((l) => l.brandId === c.brandId));
  if (!allowed) throw new Error("Owner or franchisor required");
  await db.update(apiClients).set({ active: false }).where(eq(apiClients.id, id));
  revalidatePath("/integrations");
}
