"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, invites, locations, organizations, brands } from "@/db/schema";
import { assertFranchisor, assertOrgOwner, requireViewer } from "@/lib/access";
import { env } from "@/lib/env";
import { sendMail, layout, button } from "@/lib/mail";

export async function updateBrand(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  assertFranchisor(viewer, brandId);
  const data = z
    .object({
      name: z.string().min(2),
      royaltyPct: z.coerce.number().min(0).max(50),
      adFundPct: z.coerce.number().min(0).max(50),
      requiredCerts: z.string(),
    })
    .parse({
      name: formData.get("name"),
      royaltyPct: formData.get("royaltyPct"),
      adFundPct: formData.get("adFundPct"),
      requiredCerts: formData.get("requiredCerts") ?? "",
    });
  await db
    .update(brands)
    .set({
      name: data.name,
      royaltyPct: data.royaltyPct.toFixed(2),
      adFundPct: data.adFundPct.toFixed(2),
      settings: { requiredCerts: data.requiredCerts.split(",").map((s) => s.trim()).filter(Boolean) },
    })
    .where(eq(brands.id, brandId));
  await db.insert(auditLog).values({ actorId: viewer.id, entity: "brand", entityId: brandId, action: "update", diff: data });
  revalidatePath("/brand");
}

/** Franchisor adds a franchisee: creates the org, its first store, and emails the owner an invite. */
export async function addFranchisee(formData: FormData) {
  const viewer = await requireViewer();
  const brandId = String(formData.get("brandId"));
  assertFranchisor(viewer, brandId);
  const data = z
    .object({
      orgName: z.string().min(2),
      legalName: z.string().optional(),
      ownerName: z.string().min(1),
      ownerEmail: z.string().email(),
      locationName: z.string().min(2),
      city: z.string().min(1),
      province: z.string().length(2),
    })
    .parse({
      orgName: formData.get("orgName"),
      legalName: formData.get("legalName") || undefined,
      ownerName: formData.get("ownerName"),
      ownerEmail: String(formData.get("ownerEmail")).trim().toLowerCase(),
      locationName: formData.get("locationName"),
      city: formData.get("city"),
      province: String(formData.get("province")).toUpperCase(),
    });

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const orgId = await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ brandId, name: data.orgName, legalName: data.legalName }).returning();
    const [loc] = await tx
      .insert(locations)
      .values({ brandId, organizationId: org.id, name: data.locationName, city: data.city, province: data.province, status: "planning" })
      .returning();
    await tx.insert(invites).values({
      email: data.ownerEmail,
      name: data.ownerName,
      role: "owner",
      brandId,
      organizationId: org.id,
      locationIds: [loc.id],
      token,
      invitedBy: viewer.id,
      expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
    });
    return org.id;
  });

  const url = `${env.appUrl}/invite/${token}`;
  await sendMail({
    to: data.ownerEmail,
    subject: `${env.appName}: your franchisee account`,
    text: `You've been set up as owner of ${data.orgName}. Accept: ${url}`,
    html: layout(`Welcome, ${data.ownerName}`, `<p>You've been set up as owner of <b>${data.orgName}</b> (${data.locationName}, ${data.city}).</p>${button(url, "Activate my account")}`),
  });
  await db.insert(auditLog).values({ actorId: viewer.id, entity: "organization", entityId: orgId, action: "create", diff: { owner: data.ownerEmail } });
  revalidatePath("/brand");
}

const locationSchema = z.object({
  name: z.string().min(2),
  address: z.string().optional(),
  city: z.string().optional(),
  province: z.string().length(2),
  postalCode: z.string().optional(),
  status: z.enum(["planning", "pre_opening", "open", "closed"]),
  labourTargetPct: z.coerce.number().min(0).max(100),
});

export async function createLocation(formData: FormData) {
  const viewer = await requireViewer();
  const organizationId = String(formData.get("organizationId"));
  assertOrgOwner(viewer, organizationId);
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  const data = locationSchema.parse(Object.fromEntries(formData));
  await db.insert(locations).values({ ...data, labourTargetPct: data.labourTargetPct.toFixed(2), brandId: org.brandId, organizationId });
  revalidatePath("/locations");
  revalidatePath("/dashboard");
}

export async function updateLocation(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("id"));
  const loc = viewer.locations.find((l) => l.id === id);
  if (!loc) throw new Error("Unknown location");
  assertOrgOwner(viewer, loc.organizationId);
  const data = locationSchema.parse(Object.fromEntries(formData));
  await db.update(locations).set({ ...data, labourTargetPct: data.labourTargetPct.toFixed(2) }).where(eq(locations.id, id));
  await db.insert(auditLog).values({ actorId: viewer.id, locationId: id, entity: "location", entityId: id, action: "update", diff: data });
  revalidatePath("/locations");
  revalidatePath("/dashboard");
}
