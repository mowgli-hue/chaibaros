import { json } from "@/lib/api-auth";
import { authenticateStaff, revokeStaffToken } from "@/lib/staff-auth";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const raw = await req.text();
  const a = await authenticateStaff(req, raw);
  if (a instanceof Response) return a;
  await revokeStaffToken(a.tokenId);
  return json({ ok: true });
}
