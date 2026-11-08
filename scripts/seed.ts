/**
 * Seed: The Chai Bar brand, one franchisee org with 3 stores, a franchisor+owner
 * account, a manager, three staff, suppliers and a starter ingredient list.
 *
 *   OWNER_EMAIL=you@domain.ca npx tsx scripts/seed.ts
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import bcrypt from "bcryptjs";
import { addDays, setHours, setMinutes, startOfWeek } from "date-fns";
import * as s from "../src/db/schema";

const conn = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(conn, { schema: s });

const OWNER_EMAIL = (process.env.OWNER_EMAIL ?? "mowgli@junglelabsworld.com").toLowerCase();

async function main() {
  const [brand] = await db
    .insert(s.brands)
    .values({ name: "The Chai Bar", slug: "the-chai-bar", royaltyPct: "6.00", adFundPct: "2.00", settings: { requiredCerts: ["business_licence", "health_permit", "foodsafe_l1", "insurance"] } })
    .onConflictDoNothing()
    .returning();
  const brandRow = brand ?? (await db.query.brands.findFirst({ where: (b, { eq }) => eq(b.slug, "the-chai-bar") }))!;

  const [org] = await db.insert(s.organizations).values({ brandId: brandRow.id, name: "Chai Bar King George", legalName: "1523025 B.C. Ltd." }).returning();
  const [org2] = await db.insert(s.organizations).values({ brandId: brandRow.id, name: "Chai Bar Scott Road / Kings Cross / White Rock", legalName: "1601813 B.C. Ltd." }).returning();

  const stores = await db
    .insert(s.locations)
    .values([
      { brandId: brandRow.id, organizationId: org.id, name: "King George Blvd", address: "10227 King George Blvd", city: "Surrey", province: "BC", status: "open", openedAt: new Date("2025-06-01") },
      { brandId: brandRow.id, organizationId: org2.id, name: "Scott Road (Delta)", address: "8327 120 St", city: "Delta", province: "BC", status: "open", openedAt: new Date("2026-09-15") },
      { brandId: brandRow.id, organizationId: org2.id, name: "Kings Cross", address: "#801, 7488 King George Blvd", city: "Surrey", province: "BC", status: "pre_opening" },
      { brandId: brandRow.id, organizationId: org2.id, name: "White Rock", city: "White Rock", province: "BC", status: "open", openedAt: new Date("2026-04-01") },
    ])
    .returning();
  const [kg, delta, kc, wr] = stores;

  const pin = await bcrypt.hash("1234", 10);
  const [owner] = await db.insert(s.users).values({ name: "Mowgli", email: OWNER_EMAIL, emailVerified: new Date(), pinHash: pin, phone: "+16045550100" }).returning();
  const [manager] = await db.insert(s.users).values({ name: "Store Manager", email: "manager@example.com", emailVerified: new Date(), pinHash: pin, phone: "+16045550101" }).returning();
  const staff = await db
    .insert(s.users)
    .values([
      { name: "Simran K.", email: "simran@example.com", emailVerified: new Date(), pinHash: pin, phone: "+16045550102" },
      { name: "Arjun S.", email: "arjun@example.com", emailVerified: new Date(), pinHash: pin, phone: "+16045550103" },
      { name: "Priya M.", email: "priya@example.com", emailVerified: new Date(), pinHash: pin, phone: "+16045550104" },
    ])
    .returning();

  await db.insert(s.memberships).values([
    { userId: owner.id, role: "franchisor", brandId: brandRow.id },
    { userId: owner.id, role: "owner", organizationId: org.id },
    { userId: owner.id, role: "owner", organizationId: org2.id },
    { userId: manager.id, role: "manager", locationId: kg.id },
    { userId: manager.id, role: "manager", locationId: delta.id },
    { userId: staff[0].id, role: "staff", locationId: kg.id },
    { userId: staff[1].id, role: "staff", locationId: kg.id },
    { userId: staff[1].id, role: "staff", locationId: delta.id },
    { userId: staff[2].id, role: "shift_lead", locationId: delta.id },
  ]);
  await db.insert(s.employeeProfiles).values([
    { userId: manager.id, organizationId: org.id, hourlyRateCents: 2400, startDate: new Date("2025-06-01") },
    { userId: staff[0].id, organizationId: org.id, hourlyRateCents: 1785, startDate: new Date("2025-08-01") },
    { userId: staff[1].id, organizationId: org.id, hourlyRateCents: 1850, startDate: new Date("2025-09-15") },
    { userId: staff[2].id, organizationId: org.id, hourlyRateCents: 2000, startDate: new Date("2026-10-01") },
  ]);

  // Availability: Simran weekday mornings, Arjun evenings + weekends, Priya all day Fri–Sun
  const av: (typeof s.availability.$inferInsert)[] = [];
  for (const d of [1, 2, 3, 4, 5]) av.push({ userId: staff[0].id, weekday: d, startMin: 7 * 60, endMin: 15 * 60 });
  for (const d of [1, 2, 3, 4, 5]) av.push({ userId: staff[1].id, weekday: d, startMin: 15 * 60, endMin: 23 * 60 });
  for (const d of [0, 6]) av.push({ userId: staff[1].id, weekday: d, startMin: 9 * 60, endMin: 23 * 60 });
  for (const d of [5, 6, 0]) av.push({ userId: staff[2].id, weekday: d, startMin: 8 * 60, endMin: 22 * 60 });
  await db.insert(s.availability).values(av);

  // This week's draft schedule at King George + one open shift
  const monday = startOfWeek(new Date(), { weekStartsOn: 1 });
  const at = (day: number, h: number, m = 0) => setMinutes(setHours(addDays(monday, day), h), m);
  const sh: (typeof s.shifts.$inferInsert)[] = [];
  for (let d = 0; d < 5; d++) {
    sh.push({ locationId: kg.id, userId: staff[0].id, position: "barista", startsAt: at(d, 8), endsAt: at(d, 14), breakMin: 30, status: "published", publishedAt: new Date(), createdBy: manager.id });
    sh.push({ locationId: kg.id, userId: staff[1].id, position: "barista", startsAt: at(d, 15), endsAt: at(d, 21), breakMin: 30, status: "published", publishedAt: new Date(), createdBy: manager.id });
  }
  sh.push({ locationId: kg.id, userId: null, position: "barista", startsAt: at(5, 10), endsAt: at(5, 18), breakMin: 30, status: "open", publishedAt: new Date(), createdBy: manager.id });
  sh.push({ locationId: delta.id, userId: staff[2].id, position: "lead", startsAt: at(5, 9), endsAt: at(5, 18), breakMin: 30, status: "draft", createdBy: manager.id });
  sh.push({ locationId: delta.id, userId: staff[1].id, position: "barista", startsAt: at(6, 9), endsAt: at(6, 18), breakMin: 30, status: "draft", createdBy: manager.id });
  await db.insert(s.shifts).values(sh);

  // Suppliers + ingredients (shared catalogue), stock rows per store
  const sup = await db.insert(s.suppliers).values([
    { organizationId: org2.id, name: "Costco Business Centre", phone: "" },
    { organizationId: org2.id, name: "Local dairy (Dairyland)", phone: "" },
    { organizationId: org2.id, name: "Spice wholesaler", phone: "" },
  ]).returning();
  const items: Array<[string, string, string, number, number, string]> = [
    // name, category, unit, cost per unit $, par, supplier
    ["Whole milk 4L", "Dairy", "ea", 6.49, 20, sup[1].id],
    ["Oat milk 1L", "Dairy", "ea", 3.99, 12, sup[0].id],
    ["Assam CTC tea 1kg", "Tea", "kg", 18.0, 4, sup[2].id],
    ["Sugar 10kg", "Dry goods", "kg", 1.2, 20, sup[0].id],
    ["Cardamom (green) 500g", "Spices", "g", 0.09, 500, sup[2].id],
    ["Ginger fresh", "Produce", "kg", 4.5, 3, sup[0].id],
    ["Cinnamon sticks 250g", "Spices", "g", 0.04, 250, sup[2].id],
    ["Black pepper 500g", "Spices", "g", 0.03, 250, sup[2].id],
    ["12oz hot cups", "Packaging", "case", 72.0, 2, sup[0].id],
    ["16oz hot cups", "Packaging", "case", 78.0, 2, sup[0].id],
    ["Cup lids 12/16oz", "Packaging", "case", 55.0, 2, sup[0].id],
    ["Cup sleeves", "Packaging", "case", 40.0, 1, sup[0].id],
    ["Samosa (frozen) 100ct", "Frozen", "box", 45.0, 3, sup[0].id],
    ["Paneer 2kg", "Dairy", "kg", 11.0, 4, sup[1].id],
    ["Pav / buns 24ct", "Bakery", "bag", 6.0, 6, sup[0].id],
    ["Maggi noodles case", "Dry goods", "case", 28.0, 2, sup[0].id],
    ["Butter 1lb", "Dairy", "ea", 5.5, 8, sup[1].id],
    ["Napkins case", "Packaging", "case", 35.0, 1, sup[0].id],
    ["Sanitizer tablets", "Cleaning", "ea", 0.4, 100, sup[0].id],
    ["Gloves (M) box", "Cleaning", "box", 9.0, 4, sup[0].id],
  ];
  const ings = await db.insert(s.ingredients).values(items.map(([name, category, unit, cost, , supplierId]) => ({ organizationId: org2.id, brandId: brandRow.id, name, category, unit, costCentsPerUnit: Math.round(cost * 100), supplierId }))).returning();
  const levels: (typeof s.stockLevels.$inferInsert)[] = [];
  ings.forEach((ing, i) => {
    const par = items[i][4];
    for (const loc of [kg, delta, kc, wr]) {
      const qty = loc.id === kc.id ? 0 : Math.round(par * (0.4 + Math.random() * 1.2) * 10) / 10;
      levels.push({ locationId: loc.id, ingredientId: ing.id, qty: String(qty), parLevel: String(par), lastCountedAt: loc.id === kc.id ? null : addDays(new Date(), -3) });
    }
  });
  await db.insert(s.stockLevels).values(levels);

  // Compliance
  await db.insert(s.certificates).values([
    { locationId: kg.id, kind: "business_licence", label: "City of Surrey", expiresAt: new Date("2026-12-31") },
    { locationId: kg.id, kind: "health_permit", label: "Fraser Health", expiresAt: new Date("2027-03-31") },
    { locationId: kg.id, kind: "insurance", label: "CGL policy", expiresAt: addDays(new Date(), 20) },
    { locationId: kg.id, userId: staff[0].id, kind: "foodsafe_l1", expiresAt: new Date("2028-01-01") },
    { locationId: delta.id, kind: "business_licence", label: "City of Delta", expiresAt: new Date("2027-08-31") },
    { locationId: delta.id, kind: "health_permit", label: "Fraser Health", expiresAt: new Date("2027-08-31") },
    { locationId: delta.id, userId: staff[2].id, kind: "foodsafe_l1", expiresAt: new Date("2027-10-01") },
  ]);

  // ----- Menu (brand) -----
  const cats = await db.insert(s.menuCategories).values([
    { brandId: brandRow.id, name: "Chai", sortOrder: 0 },
    { brandId: brandRow.id, name: "Coffee & Cold", sortOrder: 1 },
    { brandId: brandRow.id, name: "Snacks", sortOrder: 2 },
    { brandId: brandRow.id, name: "Retail", sortOrder: 3 },
  ]).returning();
  const [gMilk] = await db.insert(s.modifierGroups).values({ brandId: brandRow.id, name: "Milk", minSelect: 0, maxSelect: 1, sortOrder: 0 }).returning();
  const [gSweet] = await db.insert(s.modifierGroups).values({ brandId: brandRow.id, name: "Sweetness", minSelect: 0, maxSelect: 1, sortOrder: 1 }).returning();
  const [gSize] = await db.insert(s.modifierGroups).values({ brandId: brandRow.id, name: "Size", minSelect: 1, maxSelect: 1, sortOrder: 2 }).returning();
  await db.insert(s.modifiers).values([
    { groupId: gMilk.id, sku: "MILK-OAT", name: "Oat milk", priceCents: 75, sortOrder: 0 },
    { groupId: gMilk.id, sku: "MILK-ALMOND", name: "Almond milk", priceCents: 75, sortOrder: 1 },
    { groupId: gSweet.id, sku: "SWEET-LESS", name: "Less sugar", priceCents: 0, sortOrder: 0 },
    { groupId: gSweet.id, sku: "SWEET-NONE", name: "No sugar", priceCents: 0, sortOrder: 1 },
    { groupId: gSize.id, sku: "SIZE-12", name: "12 oz", priceCents: 0, sortOrder: 0 },
    { groupId: gSize.id, sku: "SIZE-16", name: "16 oz", priceCents: 100, sortOrder: 1 },
  ]);
  const ingByName = Object.fromEntries(ings.map((i) => [i.name, i.id]));
  const menu: Array<[string, string, number, string, string, string, Array<{ ingredientId: string; qty: number }>, string[]]> = [
    // sku, name, price, category, taxClass, station, recipe, groups
    ["CHAI-MASALA", "Masala Chai", 525, "Chai", "gst_only", "bar", [{ ingredientId: ingByName["Whole milk 4L"], qty: 0.06 }, { ingredientId: ingByName["Assam CTC tea 1kg"], qty: 0.012 }, { ingredientId: ingByName["Sugar 10kg"], qty: 0.015 }, { ingredientId: ingByName["12oz hot cups"], qty: 0.001 }], [gMilk.id, gSweet.id, gSize.id]],
    ["CHAI-ADRAK", "Adrak (Ginger) Chai", 550, "Chai", "gst_only", "bar", [{ ingredientId: ingByName["Whole milk 4L"], qty: 0.06 }, { ingredientId: ingByName["Ginger fresh"], qty: 0.01 }], [gMilk.id, gSweet.id, gSize.id]],
    ["CHAI-ELAICHI", "Elaichi Chai", 550, "Chai", "gst_only", "bar", [{ ingredientId: ingByName["Cardamom (green) 500g"], qty: 1.5 }], [gMilk.id, gSweet.id, gSize.id]],
    ["CHAI-KARAK", "Karak Chai", 575, "Chai", "gst_only", "bar", [], [gSweet.id, gSize.id]],
    ["CHAI-KASHMIRI", "Kashmiri Pink Chai", 650, "Chai", "gst_only", "bar", [], [gSize.id]],
    ["COF-COLD", "Cold Coffee", 625, "Coffee & Cold", "gst_only", "bar", [], [gSize.id]],
    ["LASSI-MANGO", "Mango Lassi", 650, "Coffee & Cold", "gst_only", "bar", [], []],
    ["POP-CAN", "Pop (can)", 250, "Coffee & Cold", "gst_pst", "packing", [], []],
    ["SNK-SAMOSA", "Samosa (2 pc)", 450, "Snacks", "gst_only", "kitchen", [{ ingredientId: ingByName["Samosa (frozen) 100ct"], qty: 0.02 }], []],
    ["SNK-BUNMASKA", "Bun Maska", 475, "Snacks", "gst_only", "kitchen", [{ ingredientId: ingByName["Pav / buns 24ct"], qty: 0.042 }, { ingredientId: ingByName["Butter 1lb"], qty: 0.03 }], []],
    ["SNK-MAGGI", "Masala Maggi", 750, "Snacks", "gst_only", "kitchen", [{ ingredientId: ingByName["Maggi noodles case"], qty: 0.02 }], []],
    ["SNK-PANEER", "Paneer Tikka Sandwich", 995, "Snacks", "gst_only", "kitchen", [{ ingredientId: ingByName["Paneer 2kg"], qty: 0.08 }], []],
    ["RET-MASALA", "Chai Masala tin 100g", 1200, "Retail", "gst_pst", "packing", [], []],
  ];
  const catId = (n: string) => cats.find((c) => c.name === n)!.id;
  const menuRows = await db.insert(s.menuItems).values(menu.map(([sku, name, priceCents, cat, taxClass, station, recipe], i) => ({ brandId: brandRow.id, sku, name, priceCents, categoryId: catId(cat), taxClass, station, recipe, sortOrder: i }))).returning();
  const img: (typeof s.itemModifierGroups.$inferInsert)[] = [];
  menu.forEach(([, , , , , , , groups], i) => groups.forEach((g) => img.push({ itemId: menuRows[i].id, groupId: g })));
  await db.insert(s.itemModifierGroups).values(img);
  // Kings Cross isn't open: hide everything there; White Rock marks Kashmiri chai sold out.
  await db.insert(s.itemLocationSettings).values([
    ...menuRows.map((m) => ({ locationId: kc.id, itemId: m.id, available: false })),
    { locationId: wr.id, itemId: menuRows.find((m) => m.sku === "CHAI-KASHMIRI")!.id, available: false },
  ]);

  // ----- API client for App Thru (secret printed below) -----
  const appThruSecret = "sk_demo_appthru_" + "0".repeat(32);
  await db.insert(s.apiClients).values({ brandId: brandRow.id, name: "App Thru (demo)", channel: "app_thru", keyId: "cb_demo_appthru", secret: appThruSecret, secretHash: await bcrypt.hash(appThruSecret, 10), secretHint: appThruSecret.slice(-4), webhookUrl: null });

  // ----- Loyalty program + promo codes -----
  await db.insert(s.loyaltyPrograms).values({ brandId: brandRow.id, name: "Chai Club" }).onConflictDoNothing();
  await db.insert(s.promotions).values([
    { brandId: brandRow.id, code: "FIRSTCHAI", name: "First App Thru order", kind: "percent", value: 20, channels: ["app_thru"], firstOrderOnly: true, oncePerCustomer: true },
    { brandId: brandRow.id, code: "CHAI5", name: "$5 off $25", kind: "amount", value: 500, minSubtotalCents: 2500, oncePerCustomer: false },
    { brandId: brandRow.id, code: "SAMOSA", name: "Free samosa with any chai", kind: "free_item", value: 0, freeItemSku: "SNK-SAMOSA", oncePerCustomer: true },
  ]);

  // ----- 14 days of orders across channels -----
  const { createOrder } = await import("../src/lib/orders");
  const open = [kg, delta, wr];
  const chans: Array<[string, number]> = [["clover", 0.55], ["app_thru", 0.2], ["uber_eats", 0.12], ["doordash", 0.08], ["tiffingo", 0.05]];
  const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
  const names = ["Simran", "Arjun", "Priya", "Jas", "Harleen", "Gurpreet", "Amrit", "Navi", "Rohan", "Kiran", "Manpreet", "Sukh"];
  let n = 0;
  for (let d = 13; d >= 0; d--) {
    for (const loc of open) {
      const perDay = loc.id === kg.id ? 70 : loc.id === delta.id ? 45 : 30;
      const count = Math.round(perDay * (0.7 + Math.random() * 0.6) * (d === 0 ? 0.6 : 1));
      for (let k = 0; k < count; k++) {
        const r = Math.random();
        let acc = 0; let channel = "clover";
        for (const [c, p] of chans) { acc += p; if (r <= acc) { channel = c; break; } }
        const when = new Date(); when.setDate(when.getDate() - d); when.setHours(7 + Math.floor(Math.random() * 14), Math.floor(Math.random() * 60), 0, 0);
        if (d === 0 && when > new Date()) when.setTime(Date.now() - Math.floor(Math.random() * 3600000));
        const lineCount = 1 + (Math.random() < 0.5 ? 1 : 0) + (Math.random() < 0.2 ? 1 : 0);
        const items = Array.from({ length: lineCount }, () => { const m = pick(menuRows.slice(0, 12)); return { sku: m.sku, qty: Math.random() < 0.25 ? 2 : 1, modifiers: Math.random() < 0.3 ? [{ sku: "MILK-OAT", name: "Oat milk", price_cents: 75 }] : [] }; });
        const idx = names.length ? Math.floor(Math.random() * 40) : 0;
        const customer = channel === "clover" && Math.random() < 0.6 ? undefined : { name: names[idx % names.length], phone: `+1604555${String(1000 + idx).padStart(4, "0")}`, marketing_consent: channel === "app_thru" };
        const isAgg = channel === "uber_eats" || channel === "doordash";
        const subtotalGuess = items.reduce((a, i) => a + (menuRows.find((m) => m.sku === i.sku)!.priceCents + (i.modifiers[0]?.price_cents ?? 0)) * i.qty, 0);
        const status = d === 0 && Math.random() < 0.15 ? (channel === "app_thru" ? "accepted" : channel === "clover" ? "preparing" : "received") : "completed";
        await createOrder({
          idempotency_key: `seed:${loc.id}:${d}:${k}`,
          channel: channel as "clover",
          external_id: channel === "clover" ? `CLV${100000 + n}` : channel === "app_thru" ? `AT-${20000 + n}` : `${channel.toUpperCase()}-${n}`,
          location_id: loc.id,
          fulfilment: { type: isAgg ? "delivery" : channel === "clover" ? "dine_in" : "pickup" },
          customer,
          items,
          totals: { discount_cents: 0, tip_cents: Math.random() < 0.4 ? pick([100, 150, 200, 300]) : 0, fee_cents: channel === "app_thru" ? 49 : 0, commission_cents: isAgg ? Math.round(subtotalGuess * 0.25) : 0 },
          payment: { status: "paid", provider: channel === "clover" ? "clover" : isAgg ? channel : "stripe", tender: channel === "clover" ? (Math.random() < 0.3 ? "cash" : "card") : "online" },
          placed_at: when.toISOString(),
          status: status as "completed",
        });
        n++;
      }
    }
  }
  console.log(`Seeded ${n} orders across ${open.length} open stores.`);
  console.log(`App Thru demo API client — key: cb_demo_appthru  secret: ${appThruSecret}`);
  console.log(`Seeded. Sign in as ${OWNER_EMAIL} (franchisor + owner). Store PIN for everyone: 1234.`);
}

main().then(() => conn.end()).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
