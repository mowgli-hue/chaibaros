import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, db: "up", ms: Date.now() - started, version: process.env.npm_package_version ?? "0.1.0" });
  } catch (e) {
    return Response.json({ ok: false, db: "down", error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
