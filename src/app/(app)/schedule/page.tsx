import Link from "next/link";
import { redirect } from "next/navigation";
import { addDays, isSameDay } from "date-fns";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { requireViewer, pickLocation, canManage, canSeePay } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { db } from "@/db";
import { availability, employeeProfiles, memberships, shiftClaims, shifts, users } from "@/db/schema";
import { fmtDate, fmtDay, fmtTime, parseWeek, weekRange, money, paidHours } from "@/lib/dates";
import { checkWeek, labourCostCents } from "@/lib/rules";
import { assignShift, createShift, decideClaim, deleteShift, pinPunch, publishWeek } from "@/actions/schedule";

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ location?: string; week?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const active = pickLocation(viewer, sp.location);
  if (!active) redirect("/dashboard");
  const manage = canManage(viewer, active.id);
  const { start, end, days } = weekRange(parseWeek(sp.week));

  const team = await db
    .select({ id: users.id, name: users.name, role: memberships.role, rate: employeeProfiles.hourlyRateCents, active: users.active })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
    .where(and(eq(memberships.locationId, active.id), eq(users.active, true)));
  const names = Object.fromEntries(team.map((t) => [t.id, t.name ?? "Staff"]));
  const rates = Object.fromEntries(team.map((t) => [t.id, t.rate]));

  const weekShifts = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.locationId, active.id), gte(shifts.startsAt, start), lte(shifts.startsAt, end)))
    .orderBy(shifts.startsAt);
  const avail = team.length ? await db.select().from(availability).where(inArray(availability.userId, team.map((t) => t.id))) : [];
  const claims = weekShifts.length
    ? await db.query.shiftClaims.findMany({ where: (c, { and, inArray, eq }) => and(inArray(c.shiftId, weekShifts.map((s) => s.id)), eq(c.status, "pending")), with: { user: true } })
    : [];
  const warnings = checkWeek(weekShifts, avail, names);
  const live = weekShifts.filter((s) => s.status !== "cancelled");
  const totalHours = live.reduce((a, s) => a + (s.userId ? paidHours(s.startsAt, s.endsAt, s.breakMin) : 0), 0);
  const cost = canSeePay(viewer, active.id) ? labourCostCents(live, rates) : null;
  const drafts = weekShifts.filter((s) => s.status === "draft").length;

  const prev = fmtDate(addDays(start, -7));
  const next = fmtDate(addDays(start, 7));
  const q = (w: string) => `/schedule?location=${active.id}&week=${w}`;

  return (
    <Shell viewer={viewer} locationId={active.id}>
      <PageTitle
        title={`Schedule · ${active.name}`}
        subtitle={`Week of ${fmtDay(start)} · ${live.length} shifts · ${totalHours.toFixed(1)} paid hours${cost != null ? ` · est. labour ${money(cost)}` : ""}`}
        actions={
          <div className="flex gap-2 items-center">
            <Link className="btn-secondary btn-sm" href={q(prev)}>← Prev</Link>
            <Link className="btn-secondary btn-sm" href={q(fmtDate(new Date()))}>This week</Link>
            <Link className="btn-secondary btn-sm" href={q(next)}>Next →</Link>
            {manage && (
              <form action={publishWeek}>
                <input type="hidden" name="locationId" value={active.id} />
                <input type="hidden" name="weekOf" value={start.toISOString()} />
                <button className="btn-primary btn-sm" disabled={drafts === 0 || warnings.some((w) => w.level === "error")}>
                  Publish {drafts ? `${drafts} draft${drafts > 1 ? "s" : ""}` : "(nothing to publish)"}
                </button>
              </form>
            )}
          </div>
        }
      />

      {warnings.length > 0 && (
        <div className="card mb-4 !p-3 text-sm space-y-1">
          {warnings.map((w, i) => (
            <div key={i} className={w.level === "error" ? "text-red-700" : "text-amber-700"}>{w.level === "error" ? "✖" : "⚠"} {w.message}</div>
          ))}
        </div>
      )}

      <div className="card overflow-x-auto mb-4">
        <table className="table min-w-[900px]">
          <thead>
            <tr><th className="w-40">Person</th>{days.map((d) => <th key={d.toISOString()} className={isSameDay(d, new Date()) ? "text-[var(--chai)]" : ""}>{fmtDay(d)}</th>)}<th>Hours</th></tr>
          </thead>
          <tbody>
            {[{ id: null as string | null, name: "Open shifts", role: "open", rate: null, active: true }, ...team].map((p) => {
              const mine = live.filter((s) => s.userId === p.id);
              const hrs = mine.reduce((a, s) => a + paidHours(s.startsAt, s.endsAt, s.breakMin), 0);
              return (
                <tr key={p.id ?? "open"}>
                  <td className="font-medium">{p.name}<div className="text-xs text-[#7a6a5c]">{p.role.replace("_", " ")}</div></td>
                  {days.map((d) => (
                    <td key={d.toISOString()} className="!pr-1">
                      <div className="space-y-1">
                        {mine.filter((s) => isSameDay(s.startsAt, d)).map((s) => <ShiftChip key={s.id} s={s} manage={manage} team={team} />)}
                      </div>
                    </td>
                  ))}
                  <td>{p.id ? hrs.toFixed(1) : mine.length ? `${mine.length} open` : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {manage && (
          <form action={createShift} className="card space-y-3">
            <h2 className="font-semibold">Add shift</h2>
            <input type="hidden" name="locationId" value={active.id} />
            <div><label className="label">Person</label>
              <select name="userId" className="input"><option value="">— open shift —</option>{team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Position</label><select name="position" className="input"><option value="barista">Barista</option><option value="kitchen">Kitchen</option><option value="lead">Lead</option></select></div>
              <div><label className="label">Date</label><select name="date" className="input">{days.map((d) => <option key={d.toISOString()} value={fmtDate(d)}>{fmtDay(d)}</option>)}</select></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className="label">Start</label><input name="start" type="time" className="input" defaultValue="09:00" required /></div>
              <div><label className="label">End</label><input name="end" type="time" className="input" defaultValue="17:00" required /></div>
              <div><label className="label">Break min</label><input name="breakMin" type="number" className="input" defaultValue={30} /></div>
            </div>
            <div><label className="label">Notes</label><input name="notes" className="input" placeholder="e.g. catering prep" /></div>
            <button className="btn-primary w-full">Add as draft</button>
          </form>
        )}

        {manage && (
          <div className="card">
            <h2 className="font-semibold mb-2">Open-shift claims</h2>
            {claims.length === 0 ? <p className="text-sm text-[#7a6a5c]">No pending claims.</p> : (
              <ul className="text-sm space-y-2">
                {claims.map((c) => {
                  const s = weekShifts.find((x) => x.id === c.shiftId)!;
                  return (
                    <li key={c.id} className="flex items-center justify-between gap-2">
                      <span>{c.user.name} → {fmtDay(s.startsAt)} {fmtTime(s.startsAt)}–{fmtTime(s.endsAt)}</span>
                      <span className="flex gap-1">
                        <form action={decideClaim}><input type="hidden" name="claimId" value={c.id} /><input type="hidden" name="decision" value="approved" /><button className="btn-primary btn-sm">Approve</button></form>
                        <form action={decideClaim}><input type="hidden" name="claimId" value={c.id} /><input type="hidden" name="decision" value="denied" /><button className="btn-secondary btn-sm">Deny</button></form>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <form action={pinPunch} className="card space-y-3">
          <h2 className="font-semibold">Store clock (PIN)</h2>
          <p className="text-sm text-[#7a6a5c]">Leave this page open on the counter iPad. Staff type their PIN to clock in or out.</p>
          <input type="hidden" name="locationId" value={active.id} />
          <input name="pin" inputMode="numeric" pattern="\d{4,6}" className="input text-center text-2xl tracking-[0.5em]" placeholder="••••" autoComplete="off" required />
          <button className="btn-primary w-full">Punch</button>
        </form>
      </div>
    </Shell>
  );
}

function ShiftChip({ s, manage, team }: { s: typeof shifts.$inferSelect; manage: boolean; team: { id: string; name: string | null }[] }) {
  const tone = s.status === "draft" ? "info" : s.status === "open" ? "warn" : "good";
  return (
    <div className="rounded-lg border border-[var(--line)] bg-white p-1.5 text-xs">
      <div className="flex items-center justify-between gap-1">
        <span className="font-medium">{fmtTime(s.startsAt)}–{fmtTime(s.endsAt)}</span>
        <Badge tone={tone}>{s.status}</Badge>
      </div>
      <div className="text-[#7a6a5c]">{s.position}{s.breakMin ? ` · ${s.breakMin}m break` : ""}{s.notes ? ` · ${s.notes}` : ""}</div>
      {manage && (
        <div className="flex gap-1 mt-1">
          <form action={assignShift} className="flex gap-1">
            <input type="hidden" name="id" value={s.id} />
            <select name="userId" className="input !py-0.5 !px-1 !text-xs !w-24" defaultValue={s.userId ?? ""}>
              <option value="">open</option>{team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button className="btn-secondary btn-sm !px-1.5 !py-0.5">↺</button>
          </form>
          <form action={deleteShift}><input type="hidden" name="id" value={s.id} /><button className="btn-secondary btn-sm !px-1.5 !py-0.5" title={s.status === "draft" ? "Delete" : "Cancel"}>✕</button></form>
        </div>
      )}
    </div>
  );
}
