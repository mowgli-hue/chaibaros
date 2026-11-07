/**
 * Clover REST API v3 integration.
 *
 *  - connect: merchant id + API token (Merchant → Setup → API Tokens, or an App Market OAuth token)
 *  - importMenu: Clover items/categories/modifier groups → brand menu + per-store external ids
 *  - syncClover: orders modified since the cursor → our orders (idempotent on clover:<orderId>)
 *  - pushAvailability: sold-out toggle → Clover item `available` flag (best effort)
 *
 * Regions: North America (api.clover.com), sandbox (apisandbox.dev.clover.com).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { itemLocationSettings, locationIntegrations, locations, menuCategories, menuItems, modifierGroups, modifiers, itemModifierGroups } from "@/db/schema";
import { createOrder } from "./orders";

type CloverCfg = { merchantId: string; apiToken: string; region?: "prod" | "sandbox" };

const BASE: Record<string, string> = { prod: "https://api.clover.com", sandbox: "https://apisandbox.dev.clover.com" };

async function clover<T>(cfg: CloverCfg, path: string, init?: RequestInit): Promise<T> {
  const base = BASE[cfg.region ?? "prod"];
  const res = await fetch(`${base}/v3/merchants/${cfg.merchantId}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${cfg.apiToken}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Clover ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function cfgFor(locationId: string) {
  const li = await db.query.locationIntegrations.findFirst({ where: (l, { and, eq }) => and(eq(l.locationId, locationId), eq(l.provider, "clover")) });
  if (!li) throw new Error("Clover not connected for this store");
  const cfg = li.config as unknown as CloverCfg;
  if (!cfg.merchantId || !cfg.apiToken) throw new Error("Clover merchant id / token missing");
  return { li, cfg };
}

export async function testConnection(cfg: CloverCfg) {
  const m = await clover<{ id: string; name: string; address?: { city?: string } }>(cfg, "");
  return { id: m.id, name: m.name, city: m.address?.city };
}

type CloverItem = { id: string; name: string; price: number; hidden?: boolean; available?: boolean; priceType?: string; categories?: { elements: { id: string; name: string }[] }; modifierGroups?: { elements: { id: string; name: string }[] }; code?: string; sku?: string };
type CloverCategory = { id: string; name: string; sortOrder?: number };
type CloverModGroup = { id: string; name: string; minRequired?: number; maxAllowed?: number; modifiers?: { elements: { id: string; name: string; price: number; available?: boolean }[] } };

/** Import Clover's catalogue into the brand menu. Existing items matched by external id, then by name. */
export async function importMenu(locationId: string) {
  const { cfg } = await cfgFor(locationId);
  const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
  const cats = await clover<{ elements: CloverCategory[] }>(cfg, "/categories?limit=500");
  const groups = await clover<{ elements: CloverModGroup[] }>(cfg, "/modifier_groups?expand=modifiers&limit=500");
  const items = await clover<{ elements: CloverItem[] }>(cfg, "/items?expand=categories,modifierGroups&limit=1000");

  let created = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    // Categories by name.
    const catMap = new Map<string, string>();
    for (const c of cats.elements) {
      const existing = await tx.query.menuCategories.findFirst({ where: (m, { and, eq }) => and(eq(m.brandId, loc.brandId), eq(m.name, c.name)) });
      const id = existing?.id ?? (await tx.insert(menuCategories).values({ brandId: loc.brandId, name: c.name, sortOrder: c.sortOrder ?? 0 }).returning())[0].id;
      catMap.set(c.id, id);
    }
    // Modifier groups + modifiers by name.
    const groupMap = new Map<string, string>();
    for (const g of groups.elements) {
      const existing = await tx.query.modifierGroups.findFirst({ where: (m, { and, eq }) => and(eq(m.brandId, loc.brandId), eq(m.name, g.name)) });
      const gid = existing?.id ?? (await tx.insert(modifierGroups).values({ brandId: loc.brandId, name: g.name, minSelect: g.minRequired ?? 0, maxSelect: g.maxAllowed ?? 1 }).returning())[0].id;
      groupMap.set(g.id, gid);
      for (const m of g.modifiers?.elements ?? []) {
        const sku = `CLV-${m.id}`;
        const ex = await tx.query.modifiers.findFirst({ where: (x, { and, eq }) => and(eq(x.groupId, gid), eq(x.sku, sku)) });
        if (ex) await tx.update(modifiers).set({ name: m.name, priceCents: m.price ?? 0, active: m.available !== false }).where(eq(modifiers.id, ex.id));
        else await tx.insert(modifiers).values({ groupId: gid, sku, name: m.name, priceCents: m.price ?? 0, active: m.available !== false });
      }
    }
    // Items.
    for (const it of items.elements) {
      if (it.hidden) continue;
      const sku = it.sku || it.code || `CLV-${it.id}`;
      const bySetting = await tx
        .select({ itemId: itemLocationSettings.itemId })
        .from(itemLocationSettings)
        .where(and(eq(itemLocationSettings.locationId, locationId), eq(itemLocationSettings.externalIds, { clover: it.id })));
      let itemId: string | undefined = bySetting[0]?.itemId;
      if (!itemId) {
        const byName = await tx.query.menuItems.findFirst({ where: (m, { and, eq }) => and(eq(m.brandId, loc.brandId), eq(m.name, it.name)) });
        itemId = byName?.id;
      }
      const categoryId = it.categories?.elements?.[0] ? catMap.get(it.categories.elements[0].id) ?? null : null;
      if (itemId) {
        await tx.update(menuItems).set({ categoryId: categoryId ?? undefined }).where(eq(menuItems.id, itemId));
        updated++;
      } else {
        const [row] = await tx.insert(menuItems).values({ brandId: loc.brandId, sku, name: it.name, priceCents: it.price ?? 0, categoryId }).onConflictDoNothing().returning();
        if (!row) {
          const dup = await tx.query.menuItems.findFirst({ where: (m, { and, eq }) => and(eq(m.brandId, loc.brandId), eq(m.sku, sku)) });
          itemId = dup!.id;
        } else itemId = row.id;
        created++;
      }
      const finalItemId: string = itemId!;
      for (const g of it.modifierGroups?.elements ?? []) {
        const gid = groupMap.get(g.id);
        if (gid) await tx.insert(itemModifierGroups).values({ itemId: finalItemId, groupId: gid }).onConflictDoNothing();
      }
      await tx
        .insert(itemLocationSettings)
        .values({ locationId, itemId: finalItemId, priceCents: it.price ?? null, available: it.available !== false, externalIds: { clover: it.id }, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [itemLocationSettings.locationId, itemLocationSettings.itemId], set: { priceCents: it.price ?? null, externalIds: { clover: it.id }, updatedAt: new Date() } });
    }
  });
  return { created, updated, categories: cats.elements.length, modifierGroups: groups.elements.length };
}

type CloverOrder = {
  id: string;
  createdTime: number;
  modifiedTime: number;
  state?: string; // open | locked
  total?: number;
  note?: string;
  orderType?: { labelKey?: string; label?: string };
  lineItems?: { elements: Array<{ id: string; name: string; price: number; unitQty?: number; note?: string; item?: { id: string }; modifications?: { elements: Array<{ name: string; amount: number }> } }> };
  payments?: { elements: Array<{ id: string; amount: number; tipAmount?: number; taxAmount?: number; result?: string; tender?: { label?: string; labelKey?: string } }> };
  discounts?: { elements: Array<{ amount?: number; percentage?: number }> };
  customers?: { elements: Array<{ firstName?: string; lastName?: string; phoneNumbers?: { elements: { phoneNumber: string }[] } }> };
  refunds?: { elements: Array<{ amount: number }> };
};

/** Pull orders modified since the cursor. Paid (locked) orders become completed orders in our hub. */
export async function syncClover(locationId: string) {
  const { li, cfg } = await cfgFor(locationId);
  const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
  const since = li.cursor ? Number(li.cursor) : Date.now() - 24 * 3600 * 1000;
  const path = `/orders?filter=modifiedTime>=${since}&expand=lineItems,payments,discounts,customers,refunds,lineItems.modifications&orderBy=modifiedTime%20ASC&limit=200`;
  let imported = 0;
  let skipped = 0;
  let maxModified = since;
  try {
    const res = await clover<{ elements: CloverOrder[] }>(cfg, path);
    // Map Clover item ids → our item ids for this store.
    const links = await db.select().from(itemLocationSettings).where(eq(itemLocationSettings.locationId, locationId));
    const byClover = new Map(links.map((l) => [l.externalIds.clover, l.itemId]).filter(([k]) => k) as [string, string][]);
    const itemIds = [...byClover.values()];
    const ourItems = itemIds.length ? await db.query.menuItems.findMany({ where: (m, { inArray }) => inArray(m.id, itemIds) }) : [];
    const skuOf = new Map(ourItems.map((i) => [i.id, i.sku]));

    for (const o of res.elements) {
      maxModified = Math.max(maxModified, o.modifiedTime ?? 0);
      const paid = (o.payments?.elements ?? []).filter((p) => p.result === "SUCCESS" || !p.result);
      if (o.state !== "locked" && paid.length === 0) { skipped++; continue; } // still open on the register
      const tips = paid.reduce((a, p) => a + (p.tipAmount ?? 0), 0);
      const tax = paid.reduce((a, p) => a + (p.taxAmount ?? 0), 0);
      const refunded = (o.refunds?.elements ?? []).reduce((a, r) => a + r.amount, 0);
      const lines = o.lineItems?.elements ?? [];
      const subtotal = lines.reduce((a, l) => a + l.price * (l.unitQty ? l.unitQty / 1000 : 1) + (l.modifications?.elements ?? []).reduce((x, m) => x + m.amount, 0), 0);
      const discount = (o.discounts?.elements ?? []).reduce((a, d) => a + (d.amount ? Math.abs(d.amount) : d.percentage ? Math.round((subtotal * d.percentage) / 100) : 0), 0);
      const cust = o.customers?.elements?.[0];
      const tender = paid[0]?.tender?.labelKey?.includes("cash") || paid[0]?.tender?.label?.toLowerCase().includes("cash") ? "cash" : "card";
      await createOrder(
        {
          idempotency_key: `clover:${o.id}`,
          channel: "clover",
          external_id: o.id,
          location_id: locationId,
          fulfilment: { type: o.orderType?.label?.toLowerCase().includes("deliver") ? "delivery" : "dine_in" },
          customer: cust ? { name: [cust.firstName, cust.lastName].filter(Boolean).join(" ") || undefined, phone: cust.phoneNumbers?.elements?.[0]?.phoneNumber } : undefined,
          items: lines.map((l) => {
            const ourId = l.item?.id ? byClover.get(l.item.id) : undefined;
            return {
              item_id: ourId,
              sku: ourId ? skuOf.get(ourId) : undefined,
              name: l.name,
              qty: l.unitQty ? Math.max(1, Math.round(l.unitQty / 1000)) : 1,
              unit_price_cents: l.price,
              modifiers: (l.modifications?.elements ?? []).map((m) => ({ name: m.name, price_cents: m.amount })),
              notes: l.note,
            };
          }),
          totals: { subtotal_cents: subtotal, discount_cents: discount, gst_cents: tax, pst_cents: 0, tip_cents: tips, fee_cents: 0, commission_cents: 0, total_cents: subtotal - discount + tax + tips },
          payment: { status: refunded > 0 ? "refunded" : "paid", provider: "clover", reference: paid[0]?.id, tender },
          notes: o.note,
          placed_at: new Date(o.createdTime).toISOString(),
          status: refunded > 0 ? "refunded" : "completed",
          raw: o,
        },
        null,
      );
      imported++;
    }
    await db.update(locationIntegrations).set({ status: "connected", lastSyncAt: new Date(), lastError: null, cursor: String(maxModified) }).where(eq(locationIntegrations.id, li.id));
  } catch (e) {
    await db.update(locationIntegrations).set({ status: "error", lastError: e instanceof Error ? e.message : String(e) }).where(eq(locationIntegrations.id, li.id));
    throw e;
  }
  void loc;
  return { imported, skipped, cursor: maxModified };
}

/** Best effort: mirror a sold-out toggle to Clover so the register matches. */
export async function pushAvailability(locationId: string, itemId: string, available: boolean) {
  const li = await db.query.locationIntegrations.findFirst({ where: (l, { and, eq }) => and(eq(l.locationId, locationId), eq(l.provider, "clover")) });
  if (!li || li.status === "disconnected") return false;
  const link = await db.query.itemLocationSettings.findFirst({ where: (s, { and, eq }) => and(eq(s.locationId, locationId), eq(s.itemId, itemId)) });
  const cloverId = link?.externalIds.clover;
  if (!cloverId) return false;
  try {
    await clover(li.config as unknown as CloverCfg, `/items/${cloverId}`, { method: "POST", body: JSON.stringify({ available }) });
    return true;
  } catch {
    return false;
  }
}
