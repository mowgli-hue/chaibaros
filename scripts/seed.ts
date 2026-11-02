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

  const [org] = await db.insert(s.organizations).values({ brandId: brandRow.id, name: "Chai Bar Surrey / Delta (Jungle group)", legalName: "1523025 B.C. Ltd." }).returning();

  const stores = await db
    .insert(s.locations)
    .values([
      { brandId: brandRow.id, organizationId: org.id, name: "King George Blvd", address: "10227 King George Blvd", city: "Surrey", province: "BC", status: "open", openedAt: new Date("2025-06-01") },
      { brandId: brandRow.id, organizationId: org.id, name: "Delta (Scott Road)", city: "Delta", province: "BC", status: "open", openedAt: new Date("2026-10-15") },
      { brandId: brandRow.id, organizationId: org.id, name: "Kings Cross", address: "#801, 7488 King George Blvd", city: "Surrey", province: "BC", status: "pre_opening" },
    ])
    .returning();
  const [kg, delta, kc] = stores;

  const pin = await bcrypt.hash("1234", 10);
  const [owner] = await db.insert(s.users).values({ name: "Mowgli", email: OWNER_EMAIL, emailVerified: new Date(), pinHash: pin }).returning();
  const [manager] = await db.insert(s.users).values({ name: "Store Manager", email: "manager@example.com", emailVerified: new Date(), pinHash: pin }).returning();
  const staff = await db
    .insert(s.users)
    .values([
      { name: "Simran K.", email: "simran@example.com", emailVerified: new Date(), pinHash: pin },
      { name: "Arjun S.", email: "arjun@example.com", emailVerified: new Date(), pinHash: pin },
      { name: "Priya M.", email: "priya@example.com", emailVerified: new Date(), pinHash: pin },
    ])
    .returning();

  await db.insert(s.memberships).values([
    { userId: owner.id, role: "franchisor", brandId: brandRow.id },
    { userId: owner.id, role: "owner", organizationId: org.id },
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
    { organizationId: org.id, name: "Costco Business Centre", phone: "" },
    { organizationId: org.id, name: "Local dairy (Dairyland)", phone: "" },
    { organizationId: org.id, name: "Spice wholesaler", phone: "" },
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
  const ings = await db.insert(s.ingredients).values(items.map(([name, category, unit, cost, , supplierId]) => ({ organizationId: org.id, brandId: brandRow.id, name, category, unit, costCentsPerUnit: Math.round(cost * 100), supplierId }))).returning();
  const levels: (typeof s.stockLevels.$inferInsert)[] = [];
  ings.forEach((ing, i) => {
    const par = items[i][4];
    for (const loc of [kg, delta, kc]) {
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

  console.log(`Seeded. Sign in as ${OWNER_EMAIL} (franchisor + owner). Store PIN for everyone: 1234.`);
}

main().then(() => conn.end()).catch((e) => { console.error(e); process.exit(1); });
