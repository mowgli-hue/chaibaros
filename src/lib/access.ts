import { cache } from "react";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { locations, memberships, type Location, type Role } from "@/db/schema";

export type Viewer = {
  id: string;
  name: string | null;
  email: string | null;
  memberships: Array<{
    role: Role;
    brandId: string | null;
    organizationId: string | null;
    locationId: string | null;
  }>;
  /** Every location this person may see, with their effective role at it. */
  locations: Array<Location & { role: Role }>;
  brandIds: string[];
  organizationIds: string[];
  isFranchisor: boolean;
  isOwner: boolean;
};

const RANK: Record<Role, number> = {
  franchisor: 5,
  owner: 4,
  manager: 3,
  shift_lead: 2,
  staff: 1,
};

/** Current signed-in person with resolved scope. Redirects to /login when signed out. */
export const requireViewer = cache(async (): Promise<Viewer> => {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const viewer = await loadViewer(session.user.id, session.user.name ?? null, session.user.email ?? null);
  if (!viewer) redirect("/login");
  if (viewer.memberships.length === 0) redirect("/onboarding");
  return viewer;
});

export async function loadViewer(userId: string, name: string | null, email: string | null) {
  const rows = await db
    .select({
      role: memberships.role,
      brandId: memberships.brandId,
      organizationId: memberships.organizationId,
      locationId: memberships.locationId,
    })
    .from(memberships)
    .where(eq(memberships.userId, userId));

  const brandIds = [...new Set(rows.filter((r) => r.role === "franchisor").map((r) => r.brandId!).filter(Boolean))];
  const organizationIds = [...new Set(rows.filter((r) => r.role === "owner").map((r) => r.organizationId!).filter(Boolean))];
  const directLocationIds = [...new Set(rows.map((r) => r.locationId).filter((x): x is string => Boolean(x)))];

  const visible = new Map<string, Location & { role: Role }>();
  const put = (loc: Location, role: Role) => {
    const cur = visible.get(loc.id);
    if (!cur || RANK[role] > RANK[cur.role]) visible.set(loc.id, { ...loc, role });
  };

  if (brandIds.length) {
    const locs = await db.select().from(locations).where(inArray(locations.brandId, brandIds));
    locs.forEach((l) => put(l, "franchisor"));
  }
  if (organizationIds.length) {
    const locs = await db.select().from(locations).where(inArray(locations.organizationId, organizationIds));
    locs.forEach((l) => put(l, "owner"));
  }
  if (directLocationIds.length) {
    const locs = await db.select().from(locations).where(inArray(locations.id, directLocationIds));
    for (const l of locs) {
      const role = rows.filter((r) => r.locationId === l.id).map((r) => r.role).sort((a, b) => RANK[b] - RANK[a])[0];
      if (role) put(l, role);
    }
  }

  const viewer: Viewer = {
    id: userId,
    name,
    email,
    memberships: rows,
    locations: [...visible.values()].sort((a, b) => a.name.localeCompare(b.name)),
    brandIds,
    organizationIds: [
      ...new Set([...organizationIds, ...[...visible.values()].map((l) => l.organizationId)]),
    ],
    isFranchisor: brandIds.length > 0,
    isOwner: organizationIds.length > 0,
  };
  return viewer;
}

export function roleAt(viewer: Viewer, locationId: string): Role | null {
  return viewer.locations.find((l) => l.id === locationId)?.role ?? null;
}

export function canManage(viewer: Viewer, locationId: string) {
  const r = roleAt(viewer, locationId);
  return r !== null && RANK[r] >= RANK.manager;
}

export function canSeePay(viewer: Viewer, locationId: string) {
  const r = roleAt(viewer, locationId);
  return r === "owner" || r === "manager" || r === "franchisor";
}

/** Throws unless the viewer can manage the location. Use at the top of server actions. */
export function assertManage(viewer: Viewer, locationId: string) {
  if (!canManage(viewer, locationId)) throw new Error("Not allowed for this location");
}

export function assertOrgOwner(viewer: Viewer, organizationId: string) {
  if (viewer.isFranchisor && viewer.locations.some((l) => l.organizationId === organizationId)) return;
  if (!viewer.organizationIds.includes(organizationId) || !viewer.isOwner) {
    // managers may still manage org-level catalogue for their own stores
    const ok = viewer.locations.some((l) => l.organizationId === organizationId && RANK[l.role] >= RANK.manager);
    if (!ok) throw new Error("Not allowed for this organization");
  }
}

export function assertFranchisor(viewer: Viewer, brandId: string) {
  if (!viewer.brandIds.includes(brandId)) throw new Error("Franchisor access required");
}

/** Resolve the location in the URL or the first visible one. */
export function pickLocation(viewer: Viewer, locationId?: string | null) {
  if (locationId) {
    const found = viewer.locations.find((l) => l.id === locationId);
    if (found) return found;
  }
  return viewer.locations[0] ?? null;
}

export const RoleRank = RANK;
export { and };
