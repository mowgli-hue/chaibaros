"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { certificates } from "@/db/schema";
import { assertManage, requireViewer } from "@/lib/access";

const kinds = ["business_licence", "health_permit", "foodsafe_l1", "insurance", "fire_inspection", "franchise_agreement", "other"] as const;

export async function addCertificate(formData: FormData) {
  const viewer = await requireViewer();
  const locationId = String(formData.get("locationId"));
  assertManage(viewer, locationId);
  const data = z
    .object({ kind: z.enum(kinds), label: z.string().optional(), userId: z.string().optional(), issuedAt: z.string().optional(), expiresAt: z.string().optional(), fileUrl: z.string().optional() })
    .parse(Object.fromEntries(formData));
  await db.insert(certificates).values({
    locationId,
    userId: data.userId || null,
    kind: data.kind,
    label: data.label || null,
    issuedAt: data.issuedAt ? new Date(data.issuedAt) : null,
    expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    fileUrl: data.fileUrl || null,
  });
  revalidatePath("/compliance");
  revalidatePath("/dashboard");
}

export async function removeCertificate(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("id"));
  const c = await db.query.certificates.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  if (!c?.locationId) return;
  assertManage(viewer, c.locationId);
  await db.delete(certificates).where(eq(certificates.id, id));
  revalidatePath("/compliance");
}
