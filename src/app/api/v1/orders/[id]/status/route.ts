import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { authenticate, clientMayUseLocation, json } from "@/lib/api-auth";
import { transitionOrder } from "@/lib/orders";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(["accepted", "preparing", "ready", "completed", "cancelled", "refunded"]), note: z.string().optional(), ready_by: z.string().datetime().optional() });

/** POST /api/v1/orders/:id/status — Vlink accepts / readies / cancels. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = await req.text();
  const auth = await authenticate(req, raw);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const parsed = schema.safeParse(JSON.parse(raw || "{}"));
  if (!parsed.success) return json({ error: "validation", issues: parsed.error.issues }, 422);
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o || o.brandId !== auth.client.brandId || !clientMayUseLocation(auth.client, o.locationId)) return json({ error: "not found" }, 404);
  try {
    await transitionOrder(id, parsed.data.status, null, parsed.data.note, parsed.data.ready_by ? new Date(parsed.data.ready_by) : undefined);
    return json({ order_id: id, status: parsed.data.status });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "failed" }, 409);
  }
}
