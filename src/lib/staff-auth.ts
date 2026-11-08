import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { staffTokens, users } from "@/db/schema";
import { loadViewer, type Viewer } from "./access";
import { authenticate, json } from "./api-auth";
import { normalizePhone } from "./orders";

const TOKEN_TTL_DAYS = 30;

function hash(t: string) {
  return createHash("sha256").update(t).digest("hex");
}

// Tiny in-memory limiter for PIN attempts (per identifier). Good enough per instance; add Redis at scale.
const attempts = new Map<string, { n: number; until: number }>();
export function rateLimited(key: string, max = 8, windowMs = 10 * 60000) {
  const now = Date.now();
  const cur = attempts.get(key);
  if (cur && cur.until > now && cur.n >= max) return true;
  if (!cur || cur.until <= now) attempts.set(key, { n: 1, until: now + windowMs });
  else cur.n += 1;
  return false;
}
export function clearLimit(key: string) {
  attempts.delete(key);
}

/** Email or phone + PIN → bearer token. Requires the app's API key too (so only Vlink can log staff in). */
export async function issueStaffToken(identifier: string, pin: string, apiClientId: string | null, device?: string) {
  const id = identifier.trim().toLowerCase();
  const isPhone = /^\+?[\d\s().-]{7,}$/.test(id) && !id.includes("@");
  const user = isPhone
    ? await db.query.users.findFirst({ where: (u, { eq }) => eq(u.phone, normalizePhone(id)) })
    : await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, id) });
  if (!user || !user.active || !user.pinHash) return null;
  if (!(await bcrypt.compare(pin, user.pinHash))) return null;
  const token = `st_${randomBytes(32).toString("hex")}`;
  await db.insert(staffTokens).values({ userId: user.id, tokenHash: hash(token), device: device ?? null, apiClientId, expiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * 86400000) });
  return { token, user };
}

export type StaffAuth = { viewer: Viewer; tokenId: string };

/** Validates both the app signature and the staff bearer token. */
export async function authenticateStaff(req: Request, rawBody: string): Promise<StaffAuth | Response> {
  const app = await authenticate(req, rawBody);
  if (app instanceof Response) return app;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ error: "missing bearer token" }, 401);
  const row = await db.query.staffTokens.findFirst({ where: (t, { and, eq, isNull, gt }) => and(eq(t.tokenHash, hash(bearer)), isNull(t.revokedAt), gt(t.expiresAt, new Date())) });
  if (!row) return json({ error: "invalid or expired token" }, 401);
  const [u] = await db.select().from(users).where(eq(users.id, row.userId));
  if (!u || !u.active) return json({ error: "user inactive" }, 401);
  await db.update(staffTokens).set({ lastUsedAt: new Date() }).where(eq(staffTokens.id, row.id));
  const viewer = await loadViewer(u.id, u.name, u.email);
  // Restrict to the brand of the API client.
  viewer.locations = viewer.locations.filter((l) => l.brandId === app.client.brandId);
  void and; void isNull; void gt;
  return { viewer, tokenId: row.id };
}

export async function revokeStaffToken(tokenId: string) {
  await db.update(staffTokens).set({ revokedAt: new Date() }).where(eq(staffTokens.id, tokenId));
}
