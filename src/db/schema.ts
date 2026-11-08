import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  numeric,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type { AdapterAccountType } from "next-auth/adapters";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Who a person is inside the system. Scope is set by the membership row. */
export const roleEnum = pgEnum("role", [
  "franchisor", // brand-level: sees every org and location in the brand
  "owner", // franchisee owner: all locations in their organization
  "manager", // one or more locations
  "shift_lead", // one location, limited approvals
  "staff", // one or more locations, self-service only
]);

export const locationStatusEnum = pgEnum("location_status", [
  "planning",
  "pre_opening",
  "open",
  "closed",
]);

export const shiftStatusEnum = pgEnum("shift_status", [
  "draft",
  "published",
  "open", // published with no assignee; staff can claim
  "cancelled",
]);

export const movementKindEnum = pgEnum("movement_kind", [
  "count", // physical count sets the level
  "receive", // stock in from supplier
  "waste", // thrown out
  "adjust", // manual correction
  "sale", // reserved for Phase 2 auto-depletion
]);

export const certificateKindEnum = pgEnum("certificate_kind", [
  "business_licence",
  "health_permit", // Fraser Health / regional health authority
  "foodsafe_l1",
  "insurance",
  "fire_inspection",
  "franchise_agreement",
  "other",
]);

// ---------------------------------------------------------------------------
// Tenancy: brand (franchisor) -> organization (franchisee) -> location (store)
// ---------------------------------------------------------------------------

export const brands = pgTable("brands", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  royaltyPct: numeric("royalty_pct", { precision: 5, scale: 2 }).notNull().default("6.00"),
  adFundPct: numeric("ad_fund_pct", { precision: 5, scale: 2 }).notNull().default("2.00"),
  /** Brand-wide settings: required certificates, menu rules, etc. */
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    gstNumber: text("gst_number"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("organizations_brand_idx").on(t.brandId)],
);

export const locations = pgTable(
  "locations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    city: text("city"),
    province: text("province").notNull().default("BC"),
    postalCode: text("postal_code"),
    timezone: text("timezone").notNull().default("America/Vancouver"),
    status: locationStatusEnum("status").notNull().default("planning"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    /** Weekly labour target as % of sales, used by the schedule screen. */
    labourTargetPct: numeric("labour_target_pct", { precision: 5, scale: 2 }).default("28.00"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("locations_org_idx").on(t.organizationId),
    index("locations_brand_idx").on(t.brandId),
  ],
);

// ---------------------------------------------------------------------------
// People (Auth.js tables + our membership model)
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  phone: text("phone"),
  /** bcrypt hash of the 4–6 digit PIN used on shared store devices. */
  pinHash: text("pin_hash"),
  locale: text("locale").notNull().default("en"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/**
 * One row per (user, scope, role). Scope is exactly one of brand / organization /
 * location. A franchisor has a brand-scoped row; an owner an org-scoped row;
 * managers and staff location-scoped rows (one per store they work at).
 */
export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    brandId: text("brand_id").references(() => brands.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    locationId: text("location_id").references(() => locations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memberships_user_idx").on(t.userId),
    index("memberships_location_idx").on(t.locationId),
    uniqueIndex("memberships_unique").on(
      t.userId,
      t.role,
      sql`coalesce(${t.brandId}, '')`,
      sql`coalesce(${t.organizationId}, '')`,
      sql`coalesce(${t.locationId}, '')`,
    ),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull(),
    name: text("name"),
    role: roleEnum("role").notNull(),
    brandId: text("brand_id").references(() => brands.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    locationIds: jsonb("location_ids").$type<string[]>().notNull().default([]),
    hourlyRateCents: integer("hourly_rate_cents"),
    token: text("token").notNull().unique(),
    invitedBy: text("invited_by").references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invites_email_idx").on(t.email)],
);

/** Pay and HR facts. Readable by owner/manager only (enforced in queries). */
export const employeeProfiles = pgTable("employee_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  hourlyRateCents: integer("hourly_rate_cents"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  emergencyContact: text("emergency_contact"),
  notes: text("notes"),
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Recurring weekly availability. weekday 0 = Sunday. Minutes from midnight. */
export const availability = pgTable(
  "availability",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    startMin: integer("start_min").notNull(),
    endMin: integer("end_min").notNull(),
    note: text("note"),
  },
  (t) => [index("availability_user_idx").on(t.userId)],
);

export const timeOffRequests = pgTable("time_off_requests", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  startsOn: timestamp("starts_on", { withTimezone: true }).notNull(),
  endsOn: timestamp("ends_on", { withTimezone: true }).notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("pending"), // pending | approved | denied
  decidedBy: text("decided_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shifts = pgTable(
  "shifts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    /** null = open shift on the board */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    position: text("position").notNull().default("barista"), // barista | kitchen | lead
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    breakMin: integer("break_min").notNull().default(0),
    status: shiftStatusEnum("status").notNull().default("draft"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("shifts_location_start_idx").on(t.locationId, t.startsAt),
    index("shifts_user_idx").on(t.userId),
  ],
);

export const shiftClaims = pgTable("shift_claims", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  shiftId: text("shift_id")
    .notNull()
    .references(() => shifts.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"), // pending | approved | denied
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const timeEntries = pgTable(
  "time_entries",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    shiftId: text("shift_id").references(() => shifts.id, { onDelete: "set null" }),
    clockIn: timestamp("clock_in", { withTimezone: true }).notNull(),
    clockOut: timestamp("clock_out", { withTimezone: true }),
    breakMin: integer("break_min").notNull().default(0),
    declaredTipsCents: integer("declared_tips_cents").notNull().default(0),
    editedBy: text("edited_by").references(() => users.id),
    editNote: text("edit_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("time_entries_loc_in_idx").on(t.locationId, t.clockIn)],
);

// ---------------------------------------------------------------------------
// Inventory (organization-level catalogue, location-level stock)
// ---------------------------------------------------------------------------

export const suppliers = pgTable("suppliers", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contact: text("contact"),
  phone: text("phone"),
  email: text("email"),
});

export const ingredients = pgTable(
  "ingredients",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Brand-level catalogue items are shared; null brandId = org's own. */
    brandId: text("brand_id").references(() => brands.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    category: text("category").notNull().default("General"),
    unit: text("unit").notNull().default("ea"), // kg, g, L, ml, ea, bag, box
    costCentsPerUnit: integer("cost_cents_per_unit"),
    supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ingredients_org_idx").on(t.organizationId)],
);

export const stockLevels = pgTable(
  "stock_levels",
  {
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    ingredientId: text("ingredient_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "cascade" }),
    qty: numeric("qty", { precision: 12, scale: 3 }).notNull().default("0"),
    parLevel: numeric("par_level", { precision: 12, scale: 3 }).notNull().default("0"),
    lastCountedAt: timestamp("last_counted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.locationId, t.ingredientId] })],
);

/** Append-only ledger. `resultingQty` is the level after this movement. */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    ingredientId: text("ingredient_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "cascade" }),
    kind: movementKindEnum("kind").notNull(),
    deltaQty: numeric("delta_qty", { precision: 12, scale: 3 }).notNull(),
    resultingQty: numeric("resulting_qty", { precision: 12, scale: 3 }).notNull(),
    costCents: integer("cost_cents"),
    note: text("note"),
    actorId: text("actor_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stock_movements_loc_time_idx").on(t.locationId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Compliance (what the franchisor wants to see per store)
// ---------------------------------------------------------------------------

export const certificates = pgTable(
  "certificates",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    locationId: text("location_id").references(() => locations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    kind: certificateKindEnum("kind").notNull(),
    label: text("label"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    fileUrl: text("file_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("certificates_location_idx").on(t.locationId)],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    locationId: text("location_id"),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    diff: jsonb("diff").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_entity_idx").on(t.entity, t.entityId)],
);

// ---------------------------------------------------------------------------
// Relations (for db.query.* helpers)
// ---------------------------------------------------------------------------

export const brandsRelations = relations(brands, ({ many }) => ({
  organizations: many(organizations),
  locations: many(locations),
}));

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  brand: one(brands, { fields: [organizations.brandId], references: [brands.id] }),
  locations: many(locations),
  ingredients: many(ingredients),
}));

export const locationsRelations = relations(locations, ({ one, many }) => ({
  brand: one(brands, { fields: [locations.brandId], references: [brands.id] }),
  organization: one(organizations, {
    fields: [locations.organizationId],
    references: [organizations.id],
  }),
  memberships: many(memberships),
  shifts: many(shifts),
  certificates: many(certificates),
}));

export const usersRelations = relations(users, ({ many, one }) => ({
  memberships: many(memberships),
  shifts: many(shifts),
  availability: many(availability),
  profile: one(employeeProfiles, {
    fields: [users.id],
    references: [employeeProfiles.userId],
  }),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  brand: one(brands, { fields: [memberships.brandId], references: [brands.id] }),
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
  location: one(locations, { fields: [memberships.locationId], references: [locations.id] }),
}));

export const shiftsRelations = relations(shifts, ({ one, many }) => ({
  location: one(locations, { fields: [shifts.locationId], references: [locations.id] }),
  user: one(users, { fields: [shifts.userId], references: [users.id] }),
  claims: many(shiftClaims),
}));

export const shiftClaimsRelations = relations(shiftClaims, ({ one }) => ({
  shift: one(shifts, { fields: [shiftClaims.shiftId], references: [shifts.id] }),
  user: one(users, { fields: [shiftClaims.userId], references: [users.id] }),
}));

export const ingredientsRelations = relations(ingredients, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [ingredients.organizationId],
    references: [organizations.id],
  }),
  supplier: one(suppliers, { fields: [ingredients.supplierId], references: [suppliers.id] }),
  stockLevels: many(stockLevels),
}));

export const stockLevelsRelations = relations(stockLevels, ({ one }) => ({
  ingredient: one(ingredients, {
    fields: [stockLevels.ingredientId],
    references: [ingredients.id],
  }),
  location: one(locations, { fields: [stockLevels.locationId], references: [locations.id] }),
}));

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  user: one(users, { fields: [timeEntries.userId], references: [users.id] }),
  location: one(locations, { fields: [timeEntries.locationId], references: [locations.id] }),
}));

export const certificatesRelations = relations(certificates, ({ one }) => ({
  location: one(locations, { fields: [certificates.locationId], references: [locations.id] }),
  user: one(users, { fields: [certificates.userId], references: [users.id] }),
}));

export type Role = (typeof roleEnum.enumValues)[number];
export type Brand = typeof brands.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Location = typeof locations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Shift = typeof shifts.$inferSelect;
export type Ingredient = typeof ingredients.$inferSelect;
export type StockLevel = typeof stockLevels.$inferSelect;

// ===========================================================================
// PHASE 2 — Menu, orders, customers, integrations, sales facts
// ===========================================================================

export const channelEnum = pgEnum("channel", [
  "counter", // our POS / manual entry
  "clover", // Clover POS feed
  "app_thru",
  "vlink",
  "tiffingo",
  "uber_eats",
  "doordash",
  "skip",
  "other",
]);

export const orderStatusEnum = pgEnum("order_status", [
  "received",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "cancelled",
  "refunded",
]);

export const fulfilmentEnum = pgEnum("fulfilment", ["dine_in", "pickup", "delivery"]);

export const integrationProviderEnum = pgEnum("integration_provider", [
  "clover",
  "uber_eats",
  "doordash",
  "skip",
  "otter",
]);

// ---------------------------------------------------------------------------
// Menu: master catalogue at brand level; org/location overrides
// ---------------------------------------------------------------------------

export const menuCategories = pgTable(
  "menu_categories",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("menu_categories_brand_idx").on(t.brandId)],
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => menuCategories.id, { onDelete: "set null" }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull().default(0),
    /** Tax class: gst_only (prepared food, hot drinks) | gst_pst (pop, retail goods) | exempt */
    taxClass: text("tax_class").notNull().default("gst_only"),
    station: text("station").notNull().default("bar"), // bar | kitchen | packing
    imageUrl: text("image_url"),
    allergens: jsonb("allergens").$type<string[]>().notNull().default([]),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    /** Linked ingredient depletion: [{ingredientId, qty}] — used for auto-depletion on sale. */
    recipe: jsonb("recipe").$type<Array<{ ingredientId: string; qty: number }>>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("menu_items_brand_sku").on(t.brandId, t.sku), index("menu_items_brand_idx").on(t.brandId)],
);

export const modifierGroups = pgTable("modifier_groups", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  brandId: text("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // "Milk", "Sweetness", "Size"
  minSelect: integer("min_select").notNull().default(0),
  maxSelect: integer("max_select").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const modifiers = pgTable("modifiers", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  groupId: text("group_id")
    .notNull()
    .references(() => modifierGroups.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

export const itemModifierGroups = pgTable(
  "item_modifier_groups",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => modifierGroups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.groupId] })],
);

/** Per-store overrides: price, availability (sold out), channel visibility, external POS ids. */
export const itemLocationSettings = pgTable(
  "item_location_settings",
  {
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    priceCents: integer("price_cents"), // null = brand price
    available: boolean("available").notNull().default(true),
    soldOutUntil: timestamp("sold_out_until", { withTimezone: true }),
    hiddenChannels: jsonb("hidden_channels").$type<string[]>().notNull().default([]),
    /** { clover: "ITEMID", uber_eats: "..." } */
    externalIds: jsonb("external_ids").$type<Record<string, string>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.locationId, t.itemId] })],
);

// ---------------------------------------------------------------------------
// Customers (light; CRM proper is Phase 3)
// ---------------------------------------------------------------------------

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name"),
    phone: text("phone"),
    email: text("email"),
    externalIds: jsonb("external_ids").$type<Record<string, string>>().notNull().default({}),
    marketingConsent: boolean("marketing_consent").notNull().default(false),
    consentSource: text("consent_source"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    visits: integer("visits").notNull().default(0),
    lifetimeCents: integer("lifetime_cents").notNull().default(0),
  },
  (t) => [
    uniqueIndex("customers_brand_phone").on(t.brandId, sql`coalesce(${t.phone}, '')`),
    index("customers_brand_email_idx").on(t.brandId, t.email),
  ],
);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    /** Short human number shown on tickets, per location per day. */
    number: integer("number").notNull(),
    channel: channelEnum("channel").notNull(),
    externalId: text("external_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: orderStatusEnum("status").notNull().default("received"),
    fulfilment: fulfilmentEnum("fulfilment").notNull().default("pickup"),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    readyBy: timestamp("ready_by", { withTimezone: true }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    notes: text("notes"),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    gstCents: integer("gst_cents").notNull().default(0),
    pstCents: integer("pst_cents").notNull().default(0),
    tipCents: integer("tip_cents").notNull().default(0),
    feeCents: integer("fee_cents").notNull().default(0), // App Thru $0.49, delivery fee
    commissionCents: integer("commission_cents").notNull().default(0), // aggregator commission (negative margin)
    totalCents: integer("total_cents").notNull().default(0),
    paymentStatus: text("payment_status").notNull().default("unpaid"), // unpaid | paid | refunded
    paymentProvider: text("payment_provider"),
    paymentRef: text("payment_ref"),
    tender: text("tender"), // cash | card | online | external
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_idempotency").on(t.idempotencyKey),
    index("orders_location_placed_idx").on(t.locationId, t.placedAt),
    index("orders_location_status_idx").on(t.locationId, t.status),
    index("orders_customer_idx").on(t.customerId),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    itemId: text("item_id").references(() => menuItems.id, { onDelete: "set null" }),
    sku: text("sku"),
    name: text("name").notNull(),
    qty: integer("qty").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    modifiers: jsonb("modifiers").$type<Array<{ sku?: string; name: string; priceCents: number }>>().notNull().default([]),
    notes: text("notes"),
    station: text("station").notNull().default("bar"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    lineTotalCents: integer("line_total_cents").notNull().default(0),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: orderStatusEnum("status").notNull(),
    note: text("note"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId)],
);

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

/** API clients for our own apps (App Thru, Vlink, TiffinGo). HMAC-SHA256 over the raw body. */
export const apiClients = pgTable("api_clients", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  brandId: text("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  channel: channelEnum("channel").notNull(),
  keyId: text("key_id").notNull().unique(), // public identifier sent in X-Api-Key
  secretHash: text("secret_hash").notNull(), // bcrypt of secret; secret shown once
  secretHint: text("secret_hint").notNull(), // last 4
  /** Secret kept for HMAC verification (needs raw secret). Stored encrypted-at-rest by Postgres/disk; rotate via UI. */
  secret: text("secret").notNull(),
  webhookUrl: text("webhook_url"),
  locationIds: jsonb("location_ids").$type<string[]>().notNull().default([]), // [] = all brand locations
  active: boolean("active").notNull().default(true),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Third-party POS / delivery connections per store. */
export const locationIntegrations = pgTable(
  "location_integrations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    provider: integrationProviderEnum("provider").notNull(),
    /** provider-specific: { merchantId, apiToken, region } for Clover */
    config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
    status: text("status").notNull().default("disconnected"), // disconnected | connected | error
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    cursor: text("cursor"), // e.g. last modifiedTime synced
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("location_integrations_unique").on(t.locationId, t.provider)],
);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  apiClientId: text("api_client_id").references(() => apiClients.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastStatus: integer("last_status"),
  lastError: text("last_error"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Sales facts (per location per day) — feeds dashboards and royalty
// ---------------------------------------------------------------------------

export const factSalesDaily = pgTable(
  "fact_sales_daily",
  {
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    day: text("day").notNull(), // YYYY-MM-DD in store timezone
    ordersCount: integer("orders_count").notNull().default(0),
    grossCents: integer("gross_cents").notNull().default(0), // subtotal - discount (pre-tax)
    gstCents: integer("gst_cents").notNull().default(0),
    pstCents: integer("pst_cents").notNull().default(0),
    tipsCents: integer("tips_cents").notNull().default(0),
    commissionCents: integer("commission_cents").notNull().default(0),
    byChannel: jsonb("by_channel").$type<Record<string, { orders: number; grossCents: number }>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.locationId, t.day] })],
);

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  category: one(menuCategories, { fields: [menuItems.categoryId], references: [menuCategories.id] }),
  modifierGroups: many(itemModifierGroups),
  locationSettings: many(itemLocationSettings),
}));

export const itemModifierGroupsRelations = relations(itemModifierGroups, ({ one }) => ({
  item: one(menuItems, { fields: [itemModifierGroups.itemId], references: [menuItems.id] }),
  group: one(modifierGroups, { fields: [itemModifierGroups.groupId], references: [modifierGroups.id] }),
}));

export const modifierGroupsRelations = relations(modifierGroups, ({ many }) => ({
  modifiers: many(modifiers),
  items: many(itemModifierGroups),
}));

export const modifiersRelations = relations(modifiers, ({ one }) => ({
  group: one(modifierGroups, { fields: [modifiers.groupId], references: [modifierGroups.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  location: one(locations, { fields: [orders.locationId], references: [locations.id] }),
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  items: many(orderItems),
  events: many(orderEvents),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  orders: many(orders),
}));

export type Channel = (typeof channelEnum.enumValues)[number];
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type MenuItem = typeof menuItems.$inferSelect;

// ===========================================================================
// PHASE 3 — Loyalty & promos, cash drawer / daily close, staff API tokens
// ===========================================================================

/** One program per brand. Points mode: earn `pointsPerDollar` on net sales; `redeemCentsPerPoint` sets value. */
export const loyaltyPrograms = pgTable("loyalty_programs", {
  brandId: text("brand_id")
    .primaryKey()
    .references(() => brands.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("Chai Club"),
  active: boolean("active").notNull().default(true),
  pointsPerDollar: integer("points_per_dollar").notNull().default(10), // 10 pts per $1 net
  redeemCentsPerPoint: integer("redeem_cents_per_point").notNull().default(1), // 100 pts = $1
  minRedeemPoints: integer("min_redeem_points").notNull().default(500), // $5
  maxRedeemPctOfOrder: integer("max_redeem_pct_of_order").notNull().default(50),
  signupBonusPoints: integer("signup_bonus_points").notNull().default(100),
  birthdayBonusPoints: integer("birthday_bonus_points").notNull().default(300),
  earnOnChannels: jsonb("earn_on_channels").$type<string[]>().notNull().default(["counter", "clover", "app_thru", "vlink", "tiffingo"]),
  pointsExpireDays: integer("points_expire_days"), // null = never
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loyaltyAccounts = pgTable(
  "loyalty_accounts",
  {
    customerId: text("customer_id")
      .primaryKey()
      .references(() => customers.id, { onDelete: "cascade" }),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    balance: integer("balance").notNull().default(0),
    lifetimeEarned: integer("lifetime_earned").notNull().default(0),
    lifetimeRedeemed: integer("lifetime_redeemed").notNull().default(0),
    tier: text("tier").notNull().default("member"), // member | regular | vip
    birthday: text("birthday"), // MM-DD
    lastBirthdayBonusYear: integer("last_birthday_bonus_year"),
    referralCode: text("referral_code").unique(),
    referredBy: text("referred_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("loyalty_accounts_brand_idx").on(t.brandId)],
);

/** Append-only. `delta` positive = earn, negative = redeem/expire/adjust. */
export const loyaltyLedger = pgTable(
  "loyalty_ledger",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // earn | redeem | signup | birthday | referral | adjust | expire | reversal
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    note: text("note"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("loyalty_ledger_customer_idx").on(t.customerId, t.createdAt), uniqueIndex("loyalty_ledger_order_kind").on(t.orderId, t.kind)],
);

export const promotions = pgTable(
  "promotions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("percent"), // percent | amount | free_item
    value: integer("value").notNull().default(10), // percent, or cents, or (free_item) 0
    freeItemSku: text("free_item_sku"),
    minSubtotalCents: integer("min_subtotal_cents").notNull().default(0),
    channels: jsonb("channels").$type<string[]>().notNull().default([]), // [] = all
    locationIds: jsonb("location_ids").$type<string[]>().notNull().default([]), // [] = all
    firstOrderOnly: boolean("first_order_only").notNull().default(false),
    oncePerCustomer: boolean("once_per_customer").notNull().default(true),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    maxRedemptions: integer("max_redemptions"),
    redemptions: integer("redemptions").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("promotions_brand_code").on(t.brandId, t.code)],
);

export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    promotionId: text("promotion_id")
      .notNull()
      .references(() => promotions.id, { onDelete: "cascade" }),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    discountCents: integer("discount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("promo_redemptions_promo_idx").on(t.promotionId), index("promo_redemptions_customer_idx").on(t.customerId)],
);

// ---------------------------------------------------------------------------
// Cash drawer & daily close
// ---------------------------------------------------------------------------

export const cashDrawerSessions = pgTable(
  "cash_drawer_sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    openedBy: text("opened_by").references(() => users.id, { onDelete: "set null" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openingFloatCents: integer("opening_float_cents").notNull().default(0),
    closedBy: text("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    countedCents: integer("counted_cents"),
    paidOutCents: integer("paid_out_cents").notNull().default(0), // cash paid out (supplies etc.)
    paidOutNote: text("paid_out_note"),
    expectedCents: integer("expected_cents"),
    varianceCents: integer("variance_cents"),
    depositCents: integer("deposit_cents"),
    note: text("note"),
  },
  (t) => [index("cash_drawer_location_day_idx").on(t.locationId, t.day)],
);

/** Locked snapshot of a store's day: the Z-report. One row per location per day. */
export const dailyCloses = pgTable(
  "daily_closes",
  {
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    closedBy: text("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    ordersCount: integer("orders_count").notNull().default(0),
    grossCents: integer("gross_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    netCents: integer("net_cents").notNull().default(0),
    gstCents: integer("gst_cents").notNull().default(0),
    pstCents: integer("pst_cents").notNull().default(0),
    tipsCents: integer("tips_cents").notNull().default(0),
    feesCents: integer("fees_cents").notNull().default(0),
    commissionCents: integer("commission_cents").notNull().default(0),
    refundsCents: integer("refunds_cents").notNull().default(0),
    byTender: jsonb("by_tender").$type<Record<string, number>>().notNull().default({}),
    byChannel: jsonb("by_channel").$type<Record<string, { orders: number; grossCents: number }>>().notNull().default({}),
    cashExpectedCents: integer("cash_expected_cents").notNull().default(0),
    cashCountedCents: integer("cash_counted_cents").notNull().default(0),
    cashVarianceCents: integer("cash_variance_cents").notNull().default(0),
    tipAllocations: jsonb("tip_allocations").$type<Array<{ userId: string; name: string; hours: number; cents: number }>>().notNull().default([]),
    labourCents: integer("labour_cents").notNull().default(0),
    labourHours: numeric("labour_hours", { precision: 8, scale: 2 }).notNull().default("0"),
    note: text("note"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.locationId, t.day] })],
);

// ---------------------------------------------------------------------------
// Staff API tokens (Vlink): issued after email/phone + PIN; bearer tokens, hashed at rest
// ---------------------------------------------------------------------------

export const staffTokens = pgTable(
  "staff_tokens",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    device: text("device"),
    apiClientId: text("api_client_id").references(() => apiClients.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("staff_tokens_user_idx").on(t.userId)],
);

export const loyaltyAccountsRelations = relations(loyaltyAccounts, ({ one, many }) => ({
  customer: one(customers, { fields: [loyaltyAccounts.customerId], references: [customers.id] }),
  ledger: many(loyaltyLedger),
}));
export const loyaltyLedgerRelations = relations(loyaltyLedger, ({ one }) => ({
  account: one(loyaltyAccounts, { fields: [loyaltyLedger.customerId], references: [loyaltyAccounts.customerId] }),
  order: one(orders, { fields: [loyaltyLedger.orderId], references: [orders.id] }),
}));
export const staffTokensRelations = relations(staffTokens, ({ one }) => ({
  user: one(users, { fields: [staffTokens.userId], references: [users.id] }),
}));

export type LoyaltyProgram = typeof loyaltyPrograms.$inferSelect;
export type Promotion = typeof promotions.$inferSelect;
export type DailyClose = typeof dailyCloses.$inferSelect;
