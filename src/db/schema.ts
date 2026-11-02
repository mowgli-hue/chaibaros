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
