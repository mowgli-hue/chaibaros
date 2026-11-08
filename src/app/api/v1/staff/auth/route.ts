import { z } from "zod";
import { authenticate, json } from "@/lib/api-auth";
import { clearLimit, issueStaffToken, rateLimited } from "@/lib/staff-auth";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/auth {identifier (email|phone), pin, device?} → {token, user} — Vlink login. */
export async function POST(req: Request) {
  const raw = await req.text();
  const app = await authenticate(req, raw);
  if (app instanceof Response) return app;
  const p = z.object({ identifier: z.string().min(3), pin: z.string().regex(/^\d{4,6}$/), device: z.string().optional() }).safeParse(JSON.parse(raw || "{}"));
  if (!p.success) return json({ error: "validation", issues: p.error.issues }, 422);
  const key = `pin:${p.data.identifier.toLowerCase()}`;
  if (rateLimited(key)) return json({ error: "too many attempts, try again in 10 minutes" }, 429);
  const r = await issueStaffToken(p.data.identifier, p.data.pin, app.client.id, p.data.device);
  if (!r) return json({ error: "invalid credentials" }, 401);
  clearLimit(key);
  return json({ token: r.token, expires_in_days: 30, user: { id: r.user.id, name: r.user.name, email: r.user.email, phone: r.user.phone, locale: r.user.locale } });
}
