import { redirect } from "next/navigation";
import { and, eq, gte, lte } from "drizzle-orm";
import { addDays } from "date-fns";
import { requireViewer, pickLocation, canManage, canSeePay } from "@/lib/access";
import { Shell, PageTitle } from "@/components/shell";
import { db } from "@/db";
import { employeeProfiles, timeEntries, users } from "@/db/schema";
import { fmtDate, fmtDay, fmtDateTime, money, paidHours, parseWeek, weekRange } from "@/lib/dates";
import { editTimeEntry } from "@/actions/schedule";
import Link from "next/link";

export default async function Timesheets({ searchParams }: { searchParams: Promise<{ location?: string; week?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const active = pickLocation(viewer, sp.location);
  if (!active || !canManage(viewer, active.id)) redirect("/dashboard");
  const showPay = canSeePay(viewer, active.id);
  // Bi-weekly period: the week asked for plus the previous one.
  const { start: w2Start, end } = weekRange(parseWeek(sp.week));
  const start = addDays(w2Start, -7);

  const rows = await db
    .select({ e: timeEntries, name: users.name, rate: employeeProfiles.hourlyRateCents })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
    .where(and(eq(timeEntries.locationId, active.id), gte(timeEntries.clockIn, start), lte(timeEntries.clockIn, end)))
    .orderBy(timeEntries.clockIn);

  // Per person totals with BC daily OT split.
  const people = new Map<string, { name: string; rate: number | null; reg: number; ot: number; dt: number; tips: number; days: Map<string, number> }>();
  for (const r of rows) {
    const p = people.get(r.e.userId) ?? { name: r.name ?? "Staff", rate: r.rate ?? null, reg: 0, ot: 0, dt: 0, tips: 0, days: new Map() };
    if (r.e.clockOut) {
      const h = paidHours(r.e.clockIn, r.e.clockOut, r.e.breakMin);
      const day = fmtDate(r.e.clockIn);
      const before = p.days.get(day) ?? 0;
      const after = before + h;
      p.days.set(day, after);
      p.reg += Math.max(0, Math.min(after, 8) - Math.min(before, 8));
      p.ot += Math.max(0, Math.min(after, 12) - Math.max(before, 8));
      p.dt += Math.max(0, after - Math.max(before, 12));
    }
    p.tips += r.e.declaredTipsCents;
    people.set(r.e.userId, p);
  }
  const gross = (p: { rate: number | null; reg: number; ot: number; dt: number }) => (p.rate ? Math.round(p.rate * (p.reg + p.ot * 1.5 + p.dt * 2)) : null);
  const csvRows = [["Name", "Regular h", "OT 1.5x h", "OT 2x h", "Tips CAD", "Rate CAD", "Gross CAD"], ...[...people.values()].map((p) => [p.name, p.reg.toFixed(2), p.ot.toFixed(2), p.dt.toFixed(2), (p.tips / 100).toFixed(2), p.rate ? (p.rate / 100).toFixed(2) : "", gross(p) != null ? (gross(p)! / 100).toFixed(2) : ""])];
  const csv = "data:text/csv;charset=utf-8," + encodeURIComponent(csvRows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n"));

  return (
    <Shell viewer={viewer} locationId={active.id}>
      <PageTitle
        title={`Timesheets · ${active.name}`}
        subtitle={`Pay period ${fmtDay(start)} – ${fmtDay(end)} (2 weeks). Overtime split per BC rules: 1.5× after 8h/day, 2× after 12h.`}
        actions={
          <div className="flex gap-2">
            <Link className="btn-secondary btn-sm" href={`/timesheets?location=${active.id}&week=${fmtDate(addDays(w2Start, -14))}`}>← Prev period</Link>
            <Link className="btn-secondary btn-sm" href={`/timesheets?location=${active.id}&week=${fmtDate(addDays(w2Start, 14))}`}>Next →</Link>
            <a className="btn-primary btn-sm" href={csv} download={`timesheet-${active.name}-${fmtDate(start)}.csv`}>Export CSV for payroll</a>
          </div>
        }
      />
      <div className="card overflow-x-auto mb-4">
        <table className="table">
          <thead><tr><th>Person</th><th>Regular</th><th>OT 1.5×</th><th>OT 2×</th><th>Tips</th>{showPay && <><th>Rate</th><th>Gross</th></>}</tr></thead>
          <tbody>
            {[...people.entries()].map(([id, p]) => (
              <tr key={id}><td className="font-medium">{p.name}</td><td>{p.reg.toFixed(2)}</td><td>{p.ot.toFixed(2)}</td><td>{p.dt.toFixed(2)}</td><td>{money(p.tips)}</td>{showPay && <><td>{p.rate ? `${money(p.rate)}/h` : "—"}</td><td>{gross(p) != null ? money(gross(p)) : "—"}</td></>}</tr>
            ))}
            {people.size === 0 && <tr><td colSpan={7} className="text-[#7a6a5c]">No punches in this period.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card overflow-x-auto">
        <h2 className="font-semibold mb-3">Punches · edits are logged</h2>
        <table className="table">
          <thead><tr><th>Person</th><th>In</th><th>Out</th><th>Break</th><th>Tips $</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.e.id}>
                <td>{r.name}</td>
                <td colSpan={6}>
                  <form action={editTimeEntry} className="flex flex-wrap gap-2 items-center">
                    <input type="hidden" name="id" value={r.e.id} />
                    <input name="clockIn" type="datetime-local" className="input !w-auto !py-1" defaultValue={local(r.e.clockIn)} />
                    <input name="clockOut" type="datetime-local" className="input !w-auto !py-1" defaultValue={r.e.clockOut ? local(r.e.clockOut) : ""} />
                    <input name="breakMin" type="number" className="input !w-20 !py-1" defaultValue={r.e.breakMin} />
                    <input name="tips" type="number" step="0.01" className="input !w-24 !py-1" defaultValue={(r.e.declaredTipsCents / 100).toFixed(2)} />
                    <input name="editNote" className="input !w-48 !py-1" placeholder="reason for edit" defaultValue={r.e.editNote ?? ""} />
                    <button className="btn-secondary btn-sm">Save</button>
                    {r.e.editedBy && <span className="text-xs text-[#7a6a5c]">edited</span>}
                    {!r.e.clockOut && <span className="text-xs text-green-700">on the clock since {fmtDateTime(r.e.clockIn)}</span>}
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

function local(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
