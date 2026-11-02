"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { brands, locations, memberships, organizations } from "@/db/schema";

const schema = z.object({
  brandName: z.string().min(2),
  orgName: z.string().min(2),
  locationName: z.string().min(2),
  city: z.string().min(1),
  province: z.string().min(2).max(2),
  iAmFranchisor: z.boolean(),
});

/** First-run bootstrap: creates brand + franchisee org + first store and makes the caller owner (and franchisor if ticked). */
export async function bootstrap(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const existing = await db.query.memberships.findFirst({ where: (m, { eq }) => eq(m.userId, userId) });
  if (existing) redirect("/dashboard");

  const data = schema.parse({
    brandName: formData.get("brandName"),
    orgName: formData.get("orgName"),
    locationName: formData.get("locationName"),
    city: formData.get("city"),
    province: String(formData.get("province") ?? "BC").toUpperCase(),
    iAmFranchisor: formData.get("iAmFranchisor") === "on",
  });

  await db.transaction(async (tx) => {
    const slug = data.brandName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const [brand] = await tx.insert(brands).values({ name: data.brandName, slug }).returning();
    const [org] = await tx
      .insert(organizations)
      .values({ brandId: brand.id, name: data.orgName })
      .returning();
    const [loc] = await tx
      .insert(locations)
      .values({
        brandId: brand.id,
        organizationId: org.id,
        name: data.locationName,
        city: data.city,
        province: data.province,
        status: "open",
      })
      .returning();
    await tx.insert(memberships).values({ userId, role: "owner", organizationId: org.id });
    if (data.iAmFranchisor) {
      await tx.insert(memberships).values({ userId, role: "franchisor", brandId: brand.id });
    }
    void loc;
  });

  redirect("/dashboard");
}
