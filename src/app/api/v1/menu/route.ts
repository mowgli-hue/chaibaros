import { and, eq, asc } from "drizzle-orm";
import { db } from "@/db";
import { itemLocationSettings, locations, menuCategories } from "@/db/schema";
import { authenticate, clientMayUseLocation, json } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/** GET /api/v1/menu?location_id= — the live menu for a store, with store prices and sold-out flags. ETag on content hash. */
export async function GET(req: Request) {
  const auth = await authenticate(req, "");
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const locationId = url.searchParams.get("location_id");
  if (!locationId || !clientMayUseLocation(auth.client, locationId)) return json({ error: "location_id required / not allowed" }, 403);
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.brandId, auth.client.brandId)));
  if (!loc) return json({ error: "unknown location" }, 404);

  const cats = await db.select().from(menuCategories).where(and(eq(menuCategories.brandId, loc.brandId), eq(menuCategories.active, true))).orderBy(asc(menuCategories.sortOrder));
  const items = await db.query.menuItems.findMany({
    where: (m, { and, eq }) => and(eq(m.brandId, loc.brandId), eq(m.active, true)),
    with: { modifierGroups: { with: { group: { with: { modifiers: true } } } } },
    orderBy: (m, { asc }) => asc(m.sortOrder),
  });
  const overrides = await db.select().from(itemLocationSettings).where(eq(itemLocationSettings.locationId, loc.id));
  const ov = new Map(overrides.map((o) => [o.itemId, o]));
  const channel = auth.client.channel;
  const now = Date.now();

  const payload = {
    location: { id: loc.id, name: loc.name, timezone: loc.timezone, province: loc.province },
    categories: cats.map((c) => ({ id: c.id, name: c.name })),
    items: items
      .filter((i) => !(ov.get(i.id)?.hiddenChannels ?? []).includes(channel))
      .map((i) => {
        const o = ov.get(i.id);
        const soldOut = o ? !o.available || (o.soldOutUntil ? o.soldOutUntil.getTime() > now : false) : false;
        return {
          id: i.id,
          sku: i.sku,
          name: i.name,
          description: i.description,
          category_id: i.categoryId,
          price_cents: o?.priceCents ?? i.priceCents,
          tax_class: i.taxClass,
          image_url: i.imageUrl,
          allergens: i.allergens,
          available: !soldOut,
          modifier_groups: i.modifierGroups.map((mg) => ({
            id: mg.group.id,
            name: mg.group.name,
            min: mg.group.minSelect,
            max: mg.group.maxSelect,
            modifiers: mg.group.modifiers.filter((m) => m.active).map((m) => ({ id: m.id, sku: m.sku, name: m.name, price_cents: m.priceCents })),
          })),
        };
      }),
  };
  const body = JSON.stringify(payload);
  const etag = `"${Buffer.from(String(body.length) + body.slice(0, 2000)).toString("base64url").slice(0, 32)}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  return new Response(body, { status: 200, headers: { "content-type": "application/json", etag } });
}
