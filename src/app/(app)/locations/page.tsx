import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { db } from "@/db";
import { createLocation, updateLocation } from "@/actions/franchise";

const statuses = ["planning", "pre_opening", "open", "closed"] as const;

export default async function LocationsPage() {
  const viewer = await requireViewer();
  if (!viewer.isOwner && !viewer.isFranchisor) redirect("/dashboard");
  const orgs = await db.query.organizations.findMany({ where: (o, { inArray }) => inArray(o.id, viewer.organizationIds) });

  return (
    <Shell viewer={viewer} locationId={null}>
      <PageTitle title="Locations" subtitle="Every store you own or oversee. Status drives what the franchisor dashboard shows." />
      <div className="grid gap-4 lg:grid-cols-2">
        {viewer.locations.map((l) => (
          <form key={l.id} action={updateLocation} className="card grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="id" value={l.id} />
            <div className="sm:col-span-2 flex items-center justify-between"><h2 className="font-semibold">{l.name}</h2><Badge tone={l.status === "open" ? "good" : "info"}>{l.status}</Badge></div>
            <div className="sm:col-span-2"><label className="label">Name</label><input name="name" className="input" defaultValue={l.name} /></div>
            <div className="sm:col-span-2"><label className="label">Address</label><input name="address" className="input" defaultValue={l.address ?? ""} /></div>
            <div><label className="label">City</label><input name="city" className="input" defaultValue={l.city ?? ""} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Prov.</label><input name="province" className="input" defaultValue={l.province} maxLength={2} /></div>
              <div><label className="label">Postal</label><input name="postalCode" className="input" defaultValue={l.postalCode ?? ""} /></div>
            </div>
            <div><label className="label">Status</label>
              <select name="status" className="input" defaultValue={l.status}>{statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            </div>
            <div><label className="label">Labour target % of sales</label><input name="labourTargetPct" type="number" step="0.5" className="input" defaultValue={l.labourTargetPct ?? "28"} /></div>
            <div className="sm:col-span-2"><button className="btn-secondary">Save</button></div>
          </form>
        ))}
        <form action={createLocation} className="card grid gap-3 sm:grid-cols-2 border-dashed">
          <h2 className="sm:col-span-2 font-semibold">Add a store</h2>
          <div className="sm:col-span-2"><label className="label">Franchisee</label>
            <select name="organizationId" className="input">{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          </div>
          <div className="sm:col-span-2"><label className="label">Name</label><input name="name" className="input" placeholder="e.g. Kings Cross" required /></div>
          <div className="sm:col-span-2"><label className="label">Address</label><input name="address" className="input" placeholder="#801, 7488 King George Blvd" /></div>
          <div><label className="label">City</label><input name="city" className="input" defaultValue="Surrey" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Prov.</label><input name="province" className="input" defaultValue="BC" maxLength={2} /></div>
            <div><label className="label">Postal</label><input name="postalCode" className="input" /></div>
          </div>
          <div><label className="label">Status</label><select name="status" className="input" defaultValue="planning">{statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
          <div><label className="label">Labour target %</label><input name="labourTargetPct" type="number" step="0.5" className="input" defaultValue="28" /></div>
          <div className="sm:col-span-2"><button className="btn-primary">Add store</button></div>
        </form>
      </div>
    </Shell>
  );
}
