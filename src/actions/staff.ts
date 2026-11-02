"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { db } from "@/db";
import { auditLog, employeeProfiles, invites, locations, memberships, users } from "@/db/schema";
import { assertManage, requireViewer } from "@/lib/access";
import { env } from "@/lib/env";
import { sendMail, layout, button } from "@/lib/mail";

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["owner", "manager", "shift_lead", "staff"]),
  locationIds: z.array(z.string()).min(1),
  hourlyRate: z.coerce.number().min(0).optional(),
});

export async function createInvite(formData: FormData) {
  const viewer = await requireViewer();
  const data = inviteSchema.parse({
    email: String(formData.get("email")).trim().toLowerCase(),
    name: formData.get("name"),
    role: formData.get("role"),
    locationIds: formData.getAll("locationIds").map(String),
    hourlyRate: formData.get("hourlyRate") || undefined,
  });
  data.locationIds.forEach((id) => assertManage(viewer, id));
  if (data.role === "owner" && !viewer.isOwner && !viewer.isFranchisor) throw new Error("Only owners can invite owners");

  const [loc] = await db.select().from(locations).where(eq(locations.id, data.locationIds[0]));
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);

  await db.insert(invites).values({
    email: data.email,
    name: data.name,
    role: data.role,
    organizationId: loc.organizationId,
    brandId: loc.brandId,
    locationIds: data.locationIds,
    hourlyRateCents: data.hourlyRate != null ? Math.round(data.hourlyRate * 100) : null,
    token,
    invitedBy: viewer.id,
    expiresAt,
  });

  const url = `${env.appUrl}/invite/${token}`;
  await sendMail({
    to: data.email,
    subject: `You're invited to ${env.appName}`,
    text: `${viewer.name ?? "Your manager"} invited you to ${env.appName} as ${data.role}. Accept: ${url}`,
    html: layout(
      `Join ${loc.name}`,
      `<p>${viewer.name ?? "Your manager"} invited you to <b>${env.appName}</b> as <b>${data.role.replace("_", " ")}</b>.</p>
       <p>You'll use it to see your shifts, set availability and clock in.</p>${button(url, "Accept invite")}
       <p style="font-size:12px;color:#777">Link expires in 7 days.</p>`,
    ),
  });

  await db.insert(auditLog).values({ actorId: viewer.id, locationId: data.locationIds[0], entity: "invite", entityId: data.email, action: "create", diff: { role: data.role } });
  revalidatePath("/staff");
}

/** Called from /invite/[token] once the invitee is signed in with the invited email. */
export async function acceptInvite(token: string) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) redirect(`/login?callbackUrl=/invite/${token}`);
  const invite = await db.query.invites.findFirst({ where: (i, { eq }) => eq(i.token, token) });
  if (!invite) throw new Error("Invite not found");
  if (invite.acceptedAt) redirect("/dashboard");
  if (invite.expiresAt < new Date()) throw new Error("Invite expired");
  if (invite.email !== session.user.email.toLowerCase()) throw new Error("Sign in with the invited email address");

  const userId = session.user.id;
  await db.transaction(async (tx) => {
    if (invite.name) await tx.update(users).set({ name: invite.name }).where(and(eq(users.id, userId)));
    if (invite.role === "owner") {
      await tx.insert(memberships).values({ userId, role: "owner", organizationId: invite.organizationId }).onConflictDoNothing();
    } else {
      for (const locationId of invite.locationIds) {
        await tx.insert(memberships).values({ userId, role: invite.role, locationId }).onConflictDoNothing();
      }
    }
    if (invite.organizationId) {
      await tx
        .insert(employeeProfiles)
        .values({ userId, organizationId: invite.organizationId, hourlyRateCents: invite.hourlyRateCents, startDate: new Date() })
        .onConflictDoNothing();
    }
    await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
  });
  redirect("/me");
}

export async function updateMember(formData: FormData) {
  const viewer = await requireViewer();
  const userId = String(formData.get("userId"));
  const locationId = String(formData.get("locationId"));
  const role = z.enum(["manager", "shift_lead", "staff"]).parse(formData.get("role"));
  const hourlyRate = formData.get("hourlyRate") ? Number(formData.get("hourlyRate")) : null;
  assertManage(viewer, locationId);

  await db.transaction(async (tx) => {
    await tx.delete(memberships).where(and(eq(memberships.userId, userId), eq(memberships.locationId, locationId)));
    await tx.insert(memberships).values({ userId, role, locationId });
    if (hourlyRate != null) {
      const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId));
      await tx
        .insert(employeeProfiles)
        .values({ userId, organizationId: loc.organizationId, hourlyRateCents: Math.round(hourlyRate * 100) })
        .onConflictDoUpdate({ target: employeeProfiles.userId, set: { hourlyRateCents: Math.round(hourlyRate * 100) } });
    }
    await tx.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "membership", entityId: userId, action: "update", diff: { role, hourlyRate } });
  });
  revalidatePath("/staff");
}

export async function removeFromLocation(formData: FormData) {
  const viewer = await requireViewer();
  const userId = String(formData.get("userId"));
  const locationId = String(formData.get("locationId"));
  assertManage(viewer, locationId);
  await db.delete(memberships).where(and(eq(memberships.userId, userId), eq(memberships.locationId, locationId)));
  await db.insert(auditLog).values({ actorId: viewer.id, locationId, entity: "membership", entityId: userId, action: "remove" });
  revalidatePath("/staff");
}

export async function deactivateUser(formData: FormData) {
  const viewer = await requireViewer();
  const userId = String(formData.get("userId"));
  // Must manage every location this user belongs to within the viewer's visible set.
  const rows = await db.select().from(memberships).where(eq(memberships.userId, userId));
  const locIds = rows.map((r) => r.locationId).filter((x): x is string => Boolean(x));
  locIds.forEach((id) => assertManage(viewer, id));
  await db.update(users).set({ active: false, pinHash: null }).where(eq(users.id, userId));
  await db.update(employeeProfiles).set({ endDate: new Date() }).where(eq(employeeProfiles.userId, userId));
  await db.insert(auditLog).values({ actorId: viewer.id, entity: "user", entityId: userId, action: "deactivate" });
  revalidatePath("/staff");
}

/** Anyone can set their own PIN; managers can reset a staff member's PIN. */
export async function setPin(formData: FormData) {
  const viewer = await requireViewer();
  const userId = String(formData.get("userId") ?? viewer.id);
  const pin = String(formData.get("pin"));
  if (!/^\d{4,6}$/.test(pin)) throw new Error("PIN must be 4–6 digits");
  if (userId !== viewer.id) {
    const rows = await db.select().from(memberships).where(eq(memberships.userId, userId));
    const locIds = rows.map((r) => r.locationId).filter((x): x is string => Boolean(x));
    if (!locIds.length) throw new Error("User has no store");
    locIds.forEach((id) => assertManage(viewer, id));
  }
  await db.update(users).set({ pinHash: await bcrypt.hash(pin, 10) }).where(eq(users.id, userId));
  revalidatePath("/staff");
  revalidatePath("/me");
}

export async function resendInvite(formData: FormData) {
  const viewer = await requireViewer();
  const id = String(formData.get("inviteId"));
  const invite = await db.query.invites.findFirst({ where: (i, { eq }) => eq(i.id, id) });
  if (!invite) return;
  invite.locationIds.forEach((l) => assertManage(viewer, l));
  const url = `${env.appUrl}/invite/${invite.token}`;
  await db.update(invites).set({ expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) }).where(eq(invites.id, id));
  await sendMail({ to: invite.email, subject: `Reminder: join ${env.appName}`, text: url, html: layout("Your invite", button(url, "Accept invite")) });
}

export async function listStaffForLocations(locationIds: string[]) {
  if (!locationIds.length) return [];
  return db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      active: users.active,
      hasPin: users.pinHash,
      role: memberships.role,
      locationId: memberships.locationId,
      hourlyRateCents: employeeProfiles.hourlyRateCents,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
    .where(inArray(memberships.locationId, locationIds));
}
