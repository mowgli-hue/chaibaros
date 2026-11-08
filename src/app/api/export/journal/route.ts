import { and, eq } from "drizzle-orm";
import { requireViewer, canManage } from "@/lib/access";
import { journalCsv, journalFor } from "@/lib/close";
import { db } from "@/db";
import { dailyCloses } from "@/db/schema";

export const dynamic = "force-dynamic";

/** GET /api/export/journal?location=&day=  (signed-in manager) → QBO journal CSV; marks the close exported. */
export async function GET(req: Request) {
  const viewer = await requireViewer();
  const url = new URL(req.url);
  const locationId = url.searchParams.get("location") ?? "";
  const day = url.searchParams.get("day") ?? "";
  if (!locationId || !day || !canManage(viewer, locationId)) return new Response("forbidden", { status: 403 });
  try {
    const j = await journalFor(locationId, day);
    await db.update(dailyCloses).set({ exportedAt: new Date() }).where(and(eq(dailyCloses.locationId, locationId), eq(dailyCloses.day, day)));
    return new Response(journalCsv(j), { headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="journal-${j.location.name.replace(/\s+/g, "-")}-${day}.csv"` } });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "error", { status: 400 });
  }
}
