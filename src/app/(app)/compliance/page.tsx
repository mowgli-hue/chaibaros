import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { requireViewer, canManage } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { db } from "@/db";
import { certificates, memberships, users } from "@/db/schema";
import { addCertificate, removeCertificate } from "@/actions/compliance";
import { fmtDate } from "@/lib/dates";

const labels: Record<string, string> = {
  business_licence: "Business licence",
  health_permit: "Health permit (Fraser Health / AHS / etc.)",
  foodsafe_l1: "FoodSafe Level 1",
  insurance: "Insurance (CGL)",
  fire_inspection: "Fire inspection",
  franchise_agreement: "Franchise agreement",
  other: "Other",
};

export default async function CompliancePage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const viewer = await requireViewer();
  const { location } = await searchParams;
  const managed = viewer.locations.filter((l) => canManage(viewer, l.id));
  if (!managed.length) redirect("/dashboard");
  const shown = location ? managed.filter((l) => l.id === location) : managed;

  const certs = await db.query.certificates.findMany({ where: (c, { inArray }) => inArray(c.locationId, shown.map((l) => l.id)), with: { user: true } });
  const brand = await db.query.brands.findFirst({ where: (b, { eq }) => eq(b.id, shown[0].brandId) });
  const required = ((brand?.settings as { requiredCerts?: string[] })?.requiredCerts ?? ["business_licence", "health_permit", "foodsafe_l1", "insurance"]);
  const team = await db.select({ id: users.id, name: users.name, locationId: memberships.locationId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(inArray(memberships.locationId, shown.map((l) => l.id)));
  const now = Date.now();
  const soon = now + 30 * 24 * 3600 * 1000;
  const status = (c?: { expiresAt: Date | null }) => !c ? ["missing", "bad"] as const : !c.expiresAt ? ["on file", "good"] as const : c.expiresAt.getTime() < now ? ["expired", "bad"] as const : c.expiresAt.getTime() < soon ? ["expiring", "warn"] as const : ["valid", "good"] as const;

  return (
    <Shell viewer={viewer} locationId={location ?? null}>
      <PageTitle title="Compliance" subtitle="What the franchisor and the health inspector ask for, per store. Red means act now." />
      <div className="card overflow-x-auto mb-4">
        <table className="table">
          <thead><tr><th>Store</th>{required.map((k) => <th key={k}>{labels[k] ?? k}</th>)}<th>Staff FoodSafe</th></tr></thead>
          <tbody>
            {shown.map((l) => {
              const mine = certs.filter((c) => c.locationId === l.id);
              const fs = mine.filter((c) => c.kind === "foodsafe_l1" && c.userId);
              const validFs = fs.filter((c) => status(c)[1] === "good").length;
              return (
                <tr key={l.id}>
                  <td className="font-medium">{l.name}</td>
                  {required.map((k) => {
                    const c = mine.filter((c) => c.kind === k && !c.userId).sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];
                    const [txt, tone] = status(c);
                    return <td key={k}><Badge tone={tone}>{txt}</Badge>{c?.expiresAt && <div className="text-xs text-[#7a6a5c]">{fmtDate(c.expiresAt)}</div>}</td>;
                  })}
                  <td>{validFs ? <Badge tone="good">{validFs} certified</Badge> : <Badge tone="bad">none on file</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <form action={addCertificate} className="card space-y-3">
          <h2 className="font-semibold">Add certificate / permit</h2>
          <div><label className="label">Store</label><select name="locationId" className="input">{shown.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          <div><label className="label">Type</label><select name="kind" className="input">{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label className="label">Person (for FoodSafe)</label><select name="userId" className="input"><option value="">— store-level —</option>{team.map((t) => <option key={`${t.id}-${t.locationId}`} value={t.id}>{t.name}</option>)}</select></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Issued</label><input name="issuedAt" type="date" className="input" /></div>
            <div><label className="label">Expires</label><input name="expiresAt" type="date" className="input" /></div>
          </div>
          <div><label className="label">Label / number</label><input name="label" className="input" placeholder="Licence #, policy #" /></div>
          <div><label className="label">File link (Drive/S3)</label><input name="fileUrl" className="input" placeholder="https://" /></div>
          <button className="btn-primary w-full">Save</button>
        </form>
        <div className="card lg:col-span-2 overflow-x-auto">
          <h2 className="font-semibold mb-3">All records</h2>
          <table className="table">
            <thead><tr><th>Store</th><th>Type</th><th>Person</th><th>Label</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {certs.sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity)).map((c) => {
                const [txt, tone] = status(c);
                return (
                  <tr key={c.id}>
                    <td>{shown.find((l) => l.id === c.locationId)?.name}</td><td>{labels[c.kind]}</td><td>{c.user?.name ?? ""}</td><td>{c.label}{c.fileUrl && <a className="underline ml-1" href={c.fileUrl} target="_blank">file</a>}</td><td>{c.expiresAt ? fmtDate(c.expiresAt) : "—"}</td><td><Badge tone={tone}>{txt}</Badge></td>
                    <td><form action={removeCertificate}><input type="hidden" name="id" value={c.id} /><button className="btn-secondary btn-sm">Remove</button></form></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}
