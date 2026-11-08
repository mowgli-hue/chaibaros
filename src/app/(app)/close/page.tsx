import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { addDays } from "date-fns";
import { requireViewer, pickLocation, canManage } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { CHANNEL_LABEL } from "@/components/channel";
import { db } from "@/db";
import { dailyCloses } from "@/db/schema";
import { fmtDate, money } from "@/lib/dates";
import { computeZ, journalFor } from "@/lib/close";
import { countDrawer, lockDay, openDrawer, reopenDay } from "@/actions/close";

export default async function ClosePage({ searchParams }: { searchParams: Promise<{ location?: string; day?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const active = pickLocation(viewer, sp.location);
  if (!active) redirect("/dashboard");
  const manage = canManage(viewer, active.id);
  const day = sp.day && /^\d{4}-\d{2}-\d{2}$/.test(sp.day) ? sp.day : fmtDate(new Date());
  const z = await computeZ(active.id, day);
  const [closeRow] = z.locked ? await db.select().from(dailyCloses).where(and(eq(dailyCloses.locationId, active.id), eq(dailyCloses.day, day))) : [];
  const journal = z.locked ? await journalFor(active.id, day).catch(() => null) : null;
  const q = (d: string) => `/close?location=${active.id}&day=${d}`;
  const prev = fmtDate(addDays(new Date(day + "T12:00:00"), -1));
  const next = fmtDate(addDays(new Date(day + "T12:00:00"), 1));

  return (
    <Shell viewer={viewer} locationId={active.id}>
      <PageTitle
        title={`Daily close · ${active.name}`}
        subtitle={`${day} · ${z.ordersCount} orders · net ${money(z.netCents)} · ${z.locked ? "LOCKED" : "open"}`}
        actions={<div className="flex gap-2 items-center"><a className="btn-secondary btn-sm" href={q(prev)}>← {prev}</a><a className="btn-secondary btn-sm" href={q(fmtDate(new Date()))}>Today</a><a className="btn-secondary btn-sm" href={q(next)}>{next} →</a>{z.locked && <Badge tone="good">closed {closeRow?.closedAt?.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}</Badge>}</div>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card">
          <h2 className="font-semibold mb-3">Z-report</h2>
          <table className="table">
            <tbody>
              <Row k="Gross sales" v={money(z.grossCents)} />
              <Row k="Discounts & points" v={`− ${money(z.discountCents)}`} />
              <Row k="Net sales" v={money(z.netCents)} bold />
              <Row k="GST collected" v={money(z.gstCents)} />
              <Row k="PST collected" v={money(z.pstCents)} />
              <Row k="Tips" v={money(z.tipsCents)} />
              <Row k="App Thru fees" v={money(z.feesCents)} />
              <Row k="Aggregator commission" v={`− ${money(z.commissionCents)}`} />
              <Row k="Refunds" v={`− ${money(z.refundsCents)}`} />
            </tbody>
          </table>
          <h3 className="font-semibold text-sm mt-4 mb-1">By tender</h3>
          <table className="table"><tbody>{Object.entries(z.byTender).map(([k, v]) => <Row key={k} k={k} v={money(v)} />)}</tbody></table>
          <h3 className="font-semibold text-sm mt-4 mb-1">By channel</h3>
          <table className="table"><tbody>{Object.entries(z.byChannel).map(([k, v]) => <Row key={k} k={`${CHANNEL_LABEL[k] ?? k} (${v.orders})`} v={money(v.grossCents)} />)}</tbody></table>
        </div>

        <div className="card space-y-4">
          <h2 className="font-semibold">Cash drawer</h2>
          {!z.drawer ? (
            <form action={openDrawer} className="space-y-2">
              <input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="day" value={day} />
              <div><label className="label">Opening float $</label><input name="float" type="number" step="0.01" className="input" defaultValue="200.00" /></div>
              <button className="btn-primary w-full" disabled={z.locked}>Open drawer</button>
            </form>
          ) : (
            <>
              <table className="table"><tbody>
                <Row k="Opening float" v={money(z.drawer.openingFloatCents)} />
                <Row k="Cash sales" v={money(z.byTender.cash ?? 0)} />
                <Row k="Paid out" v={`− ${money(z.drawer.paidOutCents)}`} />
                <Row k="Expected in drawer" v={money(z.cashExpectedCents)} bold />
                <Row k="Counted" v={z.drawer.countedCents != null ? money(z.drawer.countedCents) : "—"} />
                <Row k="Variance" v={z.drawer.countedCents != null ? <span className={z.cashVarianceCents === 0 ? "text-green-700" : Math.abs(z.cashVarianceCents) > 1000 ? "text-red-700 font-semibold" : "text-amber-700"}>{z.cashVarianceCents >= 0 ? "+" : ""}{money(z.cashVarianceCents)}</span> : "—"} />
              </tbody></table>
              {!z.locked && (
                <form action={countDrawer} className="space-y-2">
                  <input type="hidden" name="id" value={z.drawer.id} />
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className="label">Counted $</label><input name="counted" type="number" step="0.01" className="input" defaultValue={z.drawer.countedCents != null ? (z.drawer.countedCents / 100).toFixed(2) : ""} required /></div>
                    <div><label className="label">Deposit $</label><input name="deposit" type="number" step="0.01" className="input" defaultValue={z.drawer.depositCents != null ? (z.drawer.depositCents / 100).toFixed(2) : ""} /></div>
                    <div><label className="label">Paid out $</label><input name="paidOut" type="number" step="0.01" className="input" defaultValue={(z.drawer.paidOutCents / 100).toFixed(2)} /></div>
                    <div><label className="label">Paid-out reason</label><input name="paidOutNote" className="input" defaultValue={z.drawer.paidOutNote ?? ""} /></div>
                  </div>
                  <div><label className="label">Note</label><input name="note" className="input" defaultValue={z.drawer.note ?? ""} /></div>
                  <button className="btn-secondary w-full">Save count</button>
                </form>
              )}
            </>
          )}

          <h2 className="font-semibold pt-2">Tip pool · {money(z.tipsCents)} over {z.labourHours} h</h2>
          {z.tipAllocations.length === 0 ? <p className="text-sm text-[#7a6a5c]">No clocked hours yet today, so no allocation.</p> : (
            <table className="table"><thead><tr><th>Person</th><th>Hours</th><th>Tips</th></tr></thead><tbody>{z.tipAllocations.map((t) => <tr key={t.userId}><td>{t.name}</td><td>{t.hours}</td><td>{money(t.cents)}</td></tr>)}</tbody></table>
          )}
          <p className="text-xs text-[#7a6a5c]">Labour today ≈ {money(z.labourCents)} ({z.netCents ? Math.round((z.labourCents / z.netCents) * 100) : 0}% of net).</p>
        </div>

        <div className="card space-y-3">
          <h2 className="font-semibold">Lock & export</h2>
          {!z.locked ? (
            manage ? (
              <form action={lockDay} className="space-y-2">
                <input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="day" value={day} />
                <p className="text-sm text-[#7a6a5c]">Locking snapshots the Z-report, tip allocations and drawer count. All orders for the day must be completed or cancelled first.</p>
                <div><label className="label">Note</label><input name="note" className="input" placeholder="e.g. short $4.25, float topped up" /></div>
                <button className="btn-primary w-full">Close the day</button>
              </form>
            ) : <p className="text-sm text-[#7a6a5c]">A manager closes the day.</p>
          ) : (
            <>
              <p className="text-sm">Closed by {closeRow?.closedBy ? "manager" : "—"} · {closeRow?.note}</p>
              <a className="btn-primary w-full" href={`/api/export/journal?location=${active.id}&day=${day}`}>Download QuickBooks journal CSV</a>
              {closeRow?.exportedAt && <p className="text-xs text-[#7a6a5c]">Exported {closeRow.exportedAt.toLocaleString("en-CA")}</p>}
              {journal && (
                <table className="table text-xs"><thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
                  <tbody>{journal.lines.map((l, i) => <tr key={i}><td>{l.account}<div className="text-[#7a6a5c]">{l.memo}</div></td><td>{l.debit ? money(l.debit) : ""}</td><td>{l.credit ? money(l.credit) : ""}</td></tr>)}
                    <tr><td className="font-semibold">Total {journal.balanced ? <Badge tone="good">balanced</Badge> : <Badge tone="bad">unbalanced</Badge>}</td><td className="font-semibold">{money(journal.debit)}</td><td className="font-semibold">{money(journal.credit)}</td></tr></tbody></table>
              )}
              {(viewer.isOwner || viewer.isFranchisor) && <form action={reopenDay}><input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="day" value={day} /><button className="btn-secondary btn-sm">Reopen day (owner)</button></form>}
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Row({ k, v, bold }: { k: string; v: React.ReactNode; bold?: boolean }) {
  return <tr><td className={bold ? "font-semibold" : ""}>{k}</td><td className={`text-right ${bold ? "font-semibold" : ""}`}>{v}</td></tr>;
}
