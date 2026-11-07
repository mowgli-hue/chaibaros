import { eq } from "drizzle-orm";
import { db } from "@/db";
import { locationIntegrations } from "@/db/schema";
import { json } from "@/lib/api-auth";
import { syncClover } from "@/lib/clover";
import { retryDueWebhooks } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/cron?secret=CRON_SECRET — run every 2–5 minutes (Vercel cron / Railway cron / GitHub Actions). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") ?? req.headers.get("authorization")?.replace("Bearer ", "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return json({ error: "unauthorized" }, 401);
  const started = Date.now();
  const webhooks = await retryDueWebhooks();
  const clovers = await db.select().from(locationIntegrations).where(eq(locationIntegrations.provider, "clover"));
  const results: Record<string, unknown> = {};
  for (const li of clovers) {
    if (li.status === "disconnected") continue;
    try {
      results[li.locationId] = await syncClover(li.locationId);
    } catch (e) {
      results[li.locationId] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return json({ ok: true, ms: Date.now() - started, webhooks_retried: webhooks, clover: results });
}
