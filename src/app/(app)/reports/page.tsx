import { and, asc, gte, inArray, lte } from "drizzle-orm";
import { addDays, format, startOfMonth } from "date-fns";
import { requireViewer, canManage } from "@/lib/access";
import { Shell, PageTitle } from "@/components/shell";
import { CHANNEL_LABEL, DIRECT_CHANNELS } from "@/components/channel";
import { db } from "@/db";
import { factSalesDaily } from "@/db/schema";
import { fmtDate, money } from "@/lib/dates";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; location?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const managed = viewer.locations.filter((l) => canManage(viewer, l.id));
  const shown = sp.location ? managed.filter((l) => l.id === sp.location) : managed;
  const from = sp.from ?? fmtDate(startOfMonth(new Date()));
  const to = sp.to ?? fmtDate(new Date());
  const brands = await db.query.brands.findMany({ where: (b, { inArray }) => inArray(b.id, [...new Set(shown.map((l) => l.brandId))]) });

  const facts = shown.length
    ? await db.select().from(factSalesDaily).where(and(inArray(factSalesDaily.locationId, shown.map((l) => l.id)), gte(factSalesDaily.day, from), lte(factSalesDaily.day, to))).orderBy(asc(factSalesDaily.day))
    : [];

  type Row = { orders: number; gross: number; gst: number; pst: number; tips: number; commission: number; direct: number; aggregator: number; by: Record<string, number> };
  const perLoc = new Map<string, Row>();
  const totals: Row = { orders: 0, gross: 0, gst: 0, pst: 0, tips: 0, commission: 0, direct: 0, aggregator: 0, by: {} };
  const add = (r: Row, f: typeof facts[number]) => {
    r.orders += f.ordersCount; r.gross += f.grossCents; r.gst += f.gstCents; r.pst += f.pstCents; r.tips += f.tipsCents; r.commission += f.commissionCents;
    for (const [ch, v] of Object.entries(f.byChannel)) {
      r.by[ch] = (r.by[ch] ?? 0) + v.grossCents;
      if (DIRECT_CHANNELS.includes(ch)) r.direct += v.grossCents; else r.aggregator += v.grossCents;
    }
  };
  for (const f of facts) {
    const r = perLoc.get(f.locationId) ?? { orders: 0, gross: 0, gst: 0, pst: 0, tips: 0, commission: 0, direct: 0, aggregator: 0, by: {} };
    add(r, f); perLoc.set(f.locationId, r); add(totals, f);
  }
  const channels = [...new Set(facts.flatMap((f) => Object.keys(f.byChannel)))];
  const royaltyPct = (brandId: string) => Number(brands.find((b) => b.id === brandId)?.royaltyPct ?? 0);
  const adPct = (brandId: string) => Number(brands.find((b) => b.id === brandId)?.adFundPct ?? 0);

  const csv = "data:text/csv;charset=utf-8," + encodeURIComponent([
    ["Store", "Orders", "Net sales", "GST", "PST", "Tips", "Aggregator commission", "Royalty %", "Royalty due", "Ad fund due", ...channels.map((c) => CHANNEL_LABEL[c] ?? c)].join(","),
    ...shown.map((l) => { const r = perLoc.get(l.id); if (!r) return `"${l.name}",0`; return [`"${l.name}"`, r.orders, (r.gross / 100).toFixed(2), (r.gst / 100).toFixed(2), (r.pst / 100).toFixed(2), (r.tips / 100).toFixed(2), (r.commission / 100).toFixed(2), royaltyPct(l.brandId), ((r.gross * royaltyPct(l.brandId)) / 10000).toFixed(2), ((r.gross * adPct(l.brandId)) / 10000).toFixed(2), ...channels.map((c) => ((r.by[c] ?? 0) / 100).toFixed(2))].join(","); }),
  ].join("\n"));

  // Daily series for the chart-less sparkline table (kept simple: last 14 days)
  const days: string[] = [];
  for (let d = new Date(from + "T12:00:00"); fmtDate(d) <= to && days.length < 62; d = addDays(d, 1)) days.push(fmtDate(d));
  const daily = days.map((day) => ({ day, gross: facts.filter((f) => f.day === day).reduce((a, f) => a + f.grossCents, 0), orders: facts.filter((f) => f.day === day).reduce((a, f) => a + f.ordersCount, 0) }));
  const maxDay = Math.max(1, ...daily.map((d) => d.gross));

  return (
    <Shell viewer={viewer} locationId={sp.location ?? null}>
      <PageTitle
        title="Sales & royalty"
        subtitle={`${from} → ${to} · ${shown.length} store${shown.length === 1 ? "" : "s"} · net sales exclude tax and tips`}
        actions={
          <form className="flex gap-2 items-end">
            {sp.location && <input type="hidden" name="location" value={sp.location} />}
            <div><label className="label">From</label><input name="from" type="date" className="input" defaultValue={from} /></div>
            <div><label className="label">To</label><input name="to" type="date" className="input" defaultValue={to} /></div>
            <button className="btn-secondary">Apply</button>
            <a className="btn-primary" href={csv} download={`sales-royalty-${from}-${to}.csv`}>Export CSV</a>
          </form>
        }
      />

      <div className="grid gap-3 grid-cols-2 md:grid-cols-6 mb-4">
        <Stat label="Net sales" value={money(totals.gross)} />
        <Stat label="Orders" value={String(totals.orders)} />
        <Stat label="Avg order" value={money(totals.orders ? Math.round(totals.gross / totals.orders) : 0)} />
        <Stat label="Direct share" value={totals.gross ? `${Math.round((totals.direct / totals.gross) * 100)}%` : "—"} />
        <Stat label="Aggregator commission" value={money(totals.commission)} />
        <Stat label="Tips" value={money(totals.tips)} />
      </div>

      <div className="card overflow-x-auto mb-4">
        <table className="table">
          <thead><tr><th>Store</th><th>Orders</th><th>Net sales</th><th>GST</th><th>PST</th><th>Direct %</th>{channels.map((c) => <th key={c}>{CHANNEL_LABEL[c] ?? c}</th>)}{viewer.isFranchisor && <><th>Royalty due</th><th>Ad fund</th></>}</tr></thead>
          <tbody>
            {shown.map((l) => {
              const r = perLoc.get(l.id);
              return (
                <tr key={l.id}>
                  <td className="font-medium">{l.name}<div className="text-xs text-[#7a6a5c]">{l.city}, {l.province}</div></td>
                  <td>{r?.orders ?? 0}</td><td>{money(r?.gross ?? 0)}</td><td>{money(r?.gst ?? 0)}</td><td>{money(r?.pst ?? 0)}</td>
                  <td>{r?.gross ? `${Math.round((r.direct / r.gross) * 100)}%` : "—"}</td>
                  {channels.map((c) => <td key={c}>{money(r?.by[c] ?? 0)}</td>)}
                  {viewer.isFranchisor && <><td className="font-medium">{money(Math.round(((r?.gross ?? 0) * royaltyPct(l.brandId)) / 100))} <span className="text-xs text-[#7a6a5c]">({royaltyPct(l.brandId)}%)</span></td><td>{money(Math.round(((r?.gross ?? 0) * adPct(l.brandId)) / 100))}</td></>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-3">Net sales by day</h2>
        <div className="flex items-end gap-1 h-40">
          {daily.map((d) => (
            <div key={d.day} className="flex-1 flex flex-col items-center justify-end h-full" title={`${d.day}: ${money(d.gross)} · ${d.orders} orders`}>
              <div className="w-full rounded-t bg-[var(--chai)]" style={{ height: `${(d.gross / maxDay) * 100}%`, minHeight: d.gross ? 2 : 0 }} />
              <div className="text-[9px] text-[#7a6a5c] mt-1">{format(new Date(d.day + "T12:00:00"), "d")}</div>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="card !p-4"><div className="text-xs uppercase tracking-wide text-[#7a6a5c]">{label}</div><div className="text-2xl font-semibold">{value}</div></div>;
}
