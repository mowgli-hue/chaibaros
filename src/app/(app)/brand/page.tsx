import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { db } from "@/db";
import { addFranchisee, updateBrand } from "@/actions/franchise";
import { locationHealth } from "@/lib/queries";

export default async function BrandPage() {
  const viewer = await requireViewer();
  if (!viewer.isFranchisor) redirect("/dashboard");
  const brandList = await db.query.brands.findMany({
    where: (b, { inArray }) => inArray(b.id, viewer.brandIds),
    with: { organizations: { with: { locations: true } } },
  });
  const health = await locationHealth(viewer.locations.map((l) => l.id));
  const pendingOwnerInvites = await db.query.invites.findMany({
    where: (i, { and, inArray, isNull, eq }) => and(inArray(i.brandId, viewer.brandIds), eq(i.role, "owner"), isNull(i.acceptedAt)),
  });

  return (
    <Shell viewer={viewer} locationId={null}>
      <PageTitle title="Brand" subtitle="Franchisor view: brand rules, royalty, every franchisee and store." />
      {brandList.map((brand) => {
        const settings = (brand.settings ?? {}) as { requiredCerts?: string[] };
        return (
          <div key={brand.id} className="space-y-6">
            <div className="grid gap-4 lg:grid-cols-3">
              <form action={updateBrand} className="card space-y-3">
                <input type="hidden" name="brandId" value={brand.id} />
                <h2 className="font-semibold">Brand settings</h2>
                <div><label className="label">Brand name</label><input name="name" className="input" defaultValue={brand.name} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label">Royalty % of net sales</label><input name="royaltyPct" type="number" step="0.01" className="input" defaultValue={brand.royaltyPct} /></div>
                  <div><label className="label">Ad fund %</label><input name="adFundPct" type="number" step="0.01" className="input" defaultValue={brand.adFundPct} /></div>
                </div>
                <div>
                  <label className="label">Required certificates per store (comma-separated)</label>
                  <input name="requiredCerts" className="input" defaultValue={(settings.requiredCerts ?? ["business_licence", "health_permit", "foodsafe_l1", "insurance"]).join(", ")} />
                </div>
                <button className="btn-primary">Save</button>
                <p className="text-xs text-[#7a6a5c]">Royalty and ad fund are applied to each store&apos;s net sales once the Clover / order feed is live.</p>
              </form>

              <form action={addFranchisee} className="card space-y-3 lg:col-span-2">
                <input type="hidden" name="brandId" value={brand.id} />
                <h2 className="font-semibold">Add a franchisee</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><label className="label">Franchisee name</label><input name="orgName" className="input" placeholder="e.g. Chai Bar Calgary NE" required /></div>
                  <div><label className="label">Legal entity (optional)</label><input name="legalName" className="input" placeholder="1234567 Alberta Ltd." /></div>
                  <div><label className="label">Owner name</label><input name="ownerName" className="input" required /></div>
                  <div><label className="label">Owner email</label><input name="ownerEmail" type="email" className="input" required /></div>
                  <div><label className="label">First store name</label><input name="locationName" className="input" required /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="label">City</label><input name="city" className="input" required /></div>
                    <div><label className="label">Prov.</label><input name="province" className="input" defaultValue="AB" maxLength={2} required /></div>
                  </div>
                </div>
                <button className="btn-primary">Create franchisee and email owner invite</button>
              </form>
            </div>

            <div className="card overflow-x-auto">
              <h2 className="font-semibold mb-3">Franchisees · {brand.organizations.length}</h2>
              <table className="table">
                <thead><tr><th>Franchisee</th><th>Stores</th><th>Staff</th><th>Open shifts</th><th>Below par</th><th>Certificates</th></tr></thead>
                <tbody>
                  {brand.organizations.map((org) => {
                    const hs = org.locations.map((l) => health[l.id]).filter(Boolean);
                    const sum = (k: keyof (typeof hs)[number]) => hs.reduce((a, h) => a + (h[k] as number), 0);
                    return (
                      <tr key={org.id}>
                        <td className="font-medium">{org.name}<div className="text-xs text-[#7a6a5c]">{org.legalName}</div></td>
                        <td>{org.locations.map((l) => (<div key={l.id}>{l.name} <span className="text-xs text-[#7a6a5c]">{l.city}, {l.province}</span> <Badge tone={l.status === "open" ? "good" : "info"}>{l.status}</Badge></div>))}</td>
                        <td>{sum("staff")}</td>
                        <td>{sum("openShifts") ? <Badge tone="warn">{sum("openShifts")}</Badge> : 0}</td>
                        <td>{sum("belowPar") ? <Badge tone="warn">{sum("belowPar")}</Badge> : 0}</td>
                        <td>{sum("expiredCerts") ? <Badge tone="bad">{sum("expiredCerts")} expired</Badge> : sum("expiringCerts") ? <Badge tone="warn">{sum("expiringCerts")} expiring</Badge> : <Badge tone="good">ok</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {pendingOwnerInvites.length > 0 && (
                <p className="text-sm text-[#7a6a5c] mt-3">Pending owner invites: {pendingOwnerInvites.map((i) => i.email).join(", ")}</p>
              )}
            </div>
          </div>
        );
      })}
    </Shell>
  );
}
