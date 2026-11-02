import { redirect } from "next/navigation";
import { requireViewer, pickLocation, canManage, canSeePay } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { createInvite, deactivateUser, listStaffForLocations, removeFromLocation, resendInvite, setPin, updateMember } from "@/actions/staff";
import { db } from "@/db";
import { money } from "@/lib/dates";

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const viewer = await requireViewer();
  const { location } = await searchParams;
  const active = pickLocation(viewer, location);
  if (!active || !canManage(viewer, active.id)) redirect("/dashboard");
  const showPay = canSeePay(viewer, active.id);

  const rows = await listStaffForLocations([active.id]);
  const pending = await db.query.invites.findMany({
    where: (i, { and, isNull, sql }) => and(isNull(i.acceptedAt), sql`${i.locationIds} @> ${JSON.stringify([active.id])}::jsonb`),
    orderBy: (i, { desc }) => desc(i.createdAt),
  });
  const myManaged = viewer.locations.filter((l) => canManage(viewer, l.id));

  return (
    <Shell viewer={viewer} locationId={active.id}>
      <PageTitle title={`Staff · ${active.name}`} subtitle="Invite by email. Each person gets a sign-in link, sets a PIN for the store iPad, and sees only their own shifts, hours and tips." />

      <div className="grid gap-4 lg:grid-cols-3">
        <form action={createInvite} className="card space-y-3">
          <h2 className="font-semibold">Invite someone</h2>
          <div><label className="label">Name</label><input name="name" className="input" required /></div>
          <div><label className="label">Email</label><input name="email" type="email" className="input" required /></div>
          <div><label className="label">Role</label>
            <select name="role" className="input" defaultValue="staff">
              <option value="staff">Staff (barista / kitchen)</option>
              <option value="shift_lead">Shift lead</option>
              <option value="manager">Manager</option>
              {(viewer.isOwner || viewer.isFranchisor) && <option value="owner">Owner (whole franchisee)</option>}
            </select>
          </div>
          {showPay && <div><label className="label">Hourly rate (CAD)</label><input name="hourlyRate" type="number" step="0.25" className="input" placeholder="17.85" /></div>}
          <div>
            <label className="label">Stores</label>
            <div className="space-y-1 text-sm">
              {myManaged.map((l) => (
                <label key={l.id} className="flex items-center gap-2"><input type="checkbox" name="locationIds" value={l.id} defaultChecked={l.id === active.id} /> {l.name}</label>
              ))}
            </div>
          </div>
          <button className="btn-primary w-full">Send invite</button>
        </form>

        <div className="card lg:col-span-2 overflow-x-auto">
          <h2 className="font-semibold mb-3">Team · {rows.length}</h2>
          <table className="table">
            <thead><tr><th>Person</th><th>Role</th>{showPay && <th>Rate</th>}<th>PIN</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <td>
                    <div className="font-medium">{r.name ?? r.email}{!r.active && <Badge tone="bad">inactive</Badge>}</div>
                    <div className="text-xs text-[#7a6a5c]">{r.email}{r.phone ? ` · ${r.phone}` : ""}</div>
                  </td>
                  <td>
                    <form action={updateMember} className="flex gap-2 items-center">
                      <input type="hidden" name="userId" value={r.userId} />
                      <input type="hidden" name="locationId" value={active.id} />
                      <select name="role" className="input !w-auto !py-1" defaultValue={r.role}>
                        <option value="staff">staff</option><option value="shift_lead">shift lead</option><option value="manager">manager</option>
                      </select>
                      {showPay && <input name="hourlyRate" type="number" step="0.25" className="input !w-24 !py-1" defaultValue={r.hourlyRateCents != null ? (r.hourlyRateCents / 100).toFixed(2) : ""} placeholder="rate" />}
                      <button className="btn-secondary btn-sm">Save</button>
                    </form>
                  </td>
                  {showPay && <td>{r.hourlyRateCents != null ? `${money(r.hourlyRateCents)}/h` : "—"}</td>}
                  <td>
                    <form action={setPin} className="flex gap-1 items-center">
                      <input type="hidden" name="userId" value={r.userId} />
                      <input name="pin" inputMode="numeric" pattern="\d{4,6}" className="input !w-20 !py-1" placeholder={r.hasPin ? "set" : "none"} />
                      <button className="btn-secondary btn-sm">{r.hasPin ? "Reset" : "Set"}</button>
                    </form>
                  </td>
                  <td className="whitespace-nowrap">
                    <form action={removeFromLocation} className="inline"><input type="hidden" name="userId" value={r.userId} /><input type="hidden" name="locationId" value={active.id} /><button className="btn-secondary btn-sm mr-1">Remove from store</button></form>
                    {r.active && <form action={deactivateUser} className="inline"><input type="hidden" name="userId" value={r.userId} /><button className="btn-danger btn-sm">Deactivate</button></form>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {pending.length > 0 && (
            <>
              <h3 className="font-semibold mt-5 mb-2 text-sm">Pending invites</h3>
              <ul className="text-sm space-y-1">
                {pending.map((i) => (
                  <li key={i.id} className="flex items-center gap-3">
                    <span>{i.name} · {i.email} · <span className="text-[#7a6a5c]">{i.role}</span>{i.expiresAt < new Date() && <Badge tone="bad">expired</Badge>}</span>
                    <form action={resendInvite}><input type="hidden" name="inviteId" value={i.id} /><button className="btn-secondary btn-sm">Resend</button></form>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}
