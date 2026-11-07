import Link from "next/link";
import { requireViewer, pickLocation } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { locationHealth, myUpcomingShifts } from "@/lib/queries";
import { fmtDateTime, money } from "@/lib/dates";
import { db } from "@/db";

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const viewer = await requireViewer();
  const { location } = await searchParams;
  const active = pickLocation(viewer, location);
  const managed = viewer.locations.filter((l) => ["franchisor", "owner", "manager", "shift_lead"].includes(l.role));
  const health = await locationHealth(managed.map((l) => l.id));
  const mine = await myUpcomingShifts(viewer.id, 5);

  const brands = viewer.isFranchisor
    ? await db.query.brands.findMany({ where: (b, { inArray }) => inArray(b.id, viewer.brandIds), with: { organizations: true } })
    : [];

  const totals = Object.values(health).reduce(
    (a, h) => ({ staff: a.staff + h.staff, open: a.open + h.openShifts, draft: a.draft + h.draftShifts, par: a.par + h.belowPar, certs: a.certs + h.expiringCerts + h.expiredCerts, clocked: a.clocked + h.clockedInNow, today: a.today + h.todayGrossCents, todayOrders: a.todayOrders + h.todayOrders, mtd: a.mtd + h.mtdGrossCents, live: a.live + h.liveOrders }),
    { staff: 0, open: 0, draft: 0, par: 0, certs: 0, clocked: 0, today: 0, todayOrders: 0, mtd: 0, live: 0 },
  );
  const royaltyPct = brands[0] ? Number(brands[0].royaltyPct) : 0;

  return (
    <Shell viewer={viewer} locationId={active?.id ?? null}>
      <PageTitle
        title={viewer.isFranchisor ? "Brand overview" : viewer.isOwner ? "My stores" : `Welcome${viewer.name ? `, ${viewer.name.split(" ")[0]}` : ""}`}
        subtitle={viewer.isFranchisor ? `${brands.map((b) => b.name).join(", ")} · ${brands.reduce((n, b) => n + b.organizations.length, 0)} franchisees · ${viewer.locations.length} locations` : undefined}
      />

      {managed.length > 0 && (
        <>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4 mb-3">
            <Money label="Net sales today" value={totals.today} sub={`${totals.todayOrders} orders`} />
            <Money label="Net sales month to date" value={totals.mtd} sub={viewer.isFranchisor && royaltyPct ? `royalty due ≈ ${money(Math.round((totals.mtd * royaltyPct) / 100))}` : undefined} />
            <Stat label="Live orders" value={totals.live} tone={totals.live ? "warn" : undefined} />
            <Stat label="Stores" value={managed.length} />
          </div>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-5 mb-6">
            <Stat label="Staff" value={totals.staff} />
            <Stat label="Clocked in now" value={totals.clocked} />
            <Stat label="Open shifts this week" value={totals.open} tone={totals.open ? "warn" : "good"} />
            <Stat label="Items below par" value={totals.par} tone={totals.par ? "warn" : "good"} />
            <Stat label="Certs expiring/expired" value={totals.certs} tone={totals.certs ? "bad" : "good"} />
          </div>

          <div className="card overflow-x-auto mb-6">
            <table className="table">
              <thead>
                <tr>
                  <th>Store</th><th>Status</th><th>Today</th><th>MTD</th><th>Live</th><th>Staff</th><th>Shifts this week</th><th>Open</th><th>Draft</th><th>Clocked in</th><th>Below par</th><th>Certificates</th><th></th>
                </tr>
              </thead>
              <tbody>
                {managed.map((l) => {
                  const h = health[l.id];
                  return (
                    <tr key={l.id}>
                      <td className="font-medium">{l.name}<div className="text-xs text-[#7a6a5c]">{[l.city, l.province].filter(Boolean).join(", ")}</div></td>
                      <td><Badge tone={l.status === "open" ? "good" : l.status === "closed" ? "bad" : "info"}>{l.status.replace("_", "-")}</Badge></td>
                      <td>{money(h.todayGrossCents)}<div className="text-xs text-[#7a6a5c]">{h.todayOrders} orders</div></td>
                      <td>{money(h.mtdGrossCents)}</td>
                      <td>{h.liveOrders ? <Badge tone="warn">{h.liveOrders}</Badge> : "0"}</td>
                      <td>{h.staff}</td>
                      <td>{h.shiftsThisWeek}</td>
                      <td>{h.openShifts ? <Badge tone="warn">{h.openShifts}</Badge> : "0"}</td>
                      <td>{h.draftShifts ? <Badge tone="info">{h.draftShifts} unpublished</Badge> : "0"}</td>
                      <td>{h.clockedInNow}</td>
                      <td>{h.belowPar ? <Badge tone="warn">{h.belowPar}</Badge> : <Badge tone="good">ok</Badge>}</td>
                      <td>{h.expiredCerts ? <Badge tone="bad">{h.expiredCerts} expired</Badge> : h.expiringCerts ? <Badge tone="warn">{h.expiringCerts} expiring</Badge> : <Badge tone="good">ok</Badge>}</td>
                      <td className="whitespace-nowrap">
                        <Link className="btn-secondary btn-sm mr-1" href={`/orders?location=${l.id}`}>Orders</Link>
                        <Link className="btn-secondary btn-sm mr-1" href={`/schedule?location=${l.id}`}>Schedule</Link>
                        <Link className="btn-secondary btn-sm" href={`/inventory?location=${l.id}`}>Inventory</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <h2 className="font-semibold mb-3">My next shifts</h2>
          {mine.length === 0 ? (
            <p className="text-sm text-[#7a6a5c]">No upcoming shifts. <Link href="/me" className="underline">Set your availability</Link>.</p>
          ) : (
            <ul className="text-sm space-y-2">
              {mine.map((s) => (
                <li key={s.id} className="flex justify-between"><span>{fmtDateTime(s.startsAt)}</span><span className="text-[#7a6a5c]">{s.location.name} · {s.position}</span></li>
              ))}
            </ul>
          )}
        </div>
        {viewer.isFranchisor && (
          <div className="card">
            <h2 className="font-semibold mb-3">Franchisor tools</h2>
            <ul className="text-sm space-y-2">
              <li><Link className="underline" href="/brand">Brand settings, royalty %, franchisees</Link></li>
              <li><Link className="underline" href="/locations">All locations</Link></li>
              <li><Link className="underline" href="/compliance">Compliance across stores</Link></li>
              <li><Link className="underline" href="/reports">Sales & royalty report (export CSV)</Link></li>
              <li><Link className="underline" href="/menu">Brand menu</Link></li>
            </ul>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Money({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="card !p-4">
      <div className="text-xs uppercase tracking-wide text-[#7a6a5c]">{label}</div>
      <div className="text-2xl font-semibold">{money(value)}</div>
      {sub && <div className="text-xs text-[#7a6a5c]">{sub}</div>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-[#1f1a16]";
  return (
    <div className="card !p-4">
      <div className="text-xs uppercase tracking-wide text-[#7a6a5c]">{label}</div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}
