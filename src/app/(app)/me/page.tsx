import { requireViewer } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { db } from "@/db";
import { myUpcomingShifts, openClockEntry } from "@/lib/queries";
import { fmtDateTime, fmtTime, money, paidHours } from "@/lib/dates";
import { addAvailability, claimShift, clockIn, clockOut, removeAvailability } from "@/actions/schedule";
import { setPin } from "@/actions/staff";
import { weekRange } from "@/lib/dates";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const mins = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export default async function MePage() {
  const viewer = await requireViewer();
  const shifts = await myUpcomingShifts(viewer.id, 20);
  const open = await openClockEntry(viewer.id);
  const avail = await db.query.availability.findMany({ where: (a, { eq }) => eq(a.userId, viewer.id), orderBy: (a, { asc }) => [asc(a.weekday), asc(a.startMin)] });
  const openShifts = await db.query.shifts.findMany({
    where: (s, { and, eq, gte, inArray }) => and(eq(s.status, "open"), gte(s.startsAt, new Date()), inArray(s.locationId, viewer.locations.map((l) => l.id))),
    with: { location: true, claims: true },
    orderBy: (s, { asc }) => asc(s.startsAt),
    limit: 20,
  });
  const { start } = weekRange(new Date());
  const twoWeeksAgo = new Date(start.getTime() - 7 * 24 * 3600 * 1000);
  const entries = await db.query.timeEntries.findMany({
    where: (t, { and, eq, gte }) => and(eq(t.userId, viewer.id), gte(t.clockIn, twoWeeksAgo)),
    with: { location: true },
    orderBy: (t, { desc }) => desc(t.clockIn),
  });
  const hours = entries.reduce((a, e) => a + (e.clockOut ? paidHours(e.clockIn, e.clockOut, e.breakMin) : 0), 0);
  const tips = entries.reduce((a, e) => a + e.declaredTipsCents, 0);
  const me = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, viewer.id) });

  return (
    <Shell viewer={viewer} locationId={null}>
      <PageTitle title="My shifts" subtitle="Your upcoming shifts, clock in/out, availability, open shifts you can claim, and your hours and tips." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="font-semibold mb-3">Upcoming</h2>
          {shifts.length === 0 ? <p className="text-sm text-[#7a6a5c]">Nothing scheduled yet.</p> : (
            <ul className="divide-y divide-[var(--line)] text-sm">
              {shifts.map((s) => (
                <li key={s.id} className="py-2 flex justify-between"><span className="font-medium">{fmtDateTime(s.startsAt)} – {fmtTime(s.endsAt)}</span><span className="text-[#7a6a5c]">{s.location.name} · {s.position}{s.breakMin ? ` · ${s.breakMin}m break` : ""}</span></li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2 className="font-semibold mb-3">Clock</h2>
          {open ? (
            <form action={clockOut} className="space-y-2">
              <p className="text-sm">Clocked in at <b>{fmtDateTime(open.clockIn)}</b> · {open.location.name}</p>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Break min</label><input name="breakMin" type="number" className="input" defaultValue={30} /></div>
                <div><label className="label">Cash tips $</label><input name="tips" type="number" step="0.01" className="input" defaultValue={0} /></div>
              </div>
              <button className="btn-danger w-full">Clock out</button>
            </form>
          ) : (
            <form action={clockIn} className="space-y-2">
              <div><label className="label">Store</label>
                <select name="locationId" className="input">{viewer.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              </div>
              <button className="btn-primary w-full">Clock in</button>
            </form>
          )}
          <div className="mt-4 text-sm">
            <div className="flex justify-between"><span>Last 2 weeks</span><b>{hours.toFixed(1)} h</b></div>
            <div className="flex justify-between"><span>Declared tips</span><b>{money(tips)}</b></div>
          </div>
          <form action={setPin} className="mt-4 flex gap-2 items-end">
            <div className="flex-1"><label className="label">{me?.pinHash ? "Change store PIN" : "Set store PIN"}</label><input name="pin" inputMode="numeric" pattern="\d{4,6}" className="input" placeholder="4–6 digits" /></div>
            <button className="btn-secondary">Save</button>
          </form>
        </div>

        <div className="card">
          <h2 className="font-semibold mb-3">My availability</h2>
          <ul className="text-sm space-y-1 mb-3">
            {avail.map((a) => (
              <li key={a.id} className="flex justify-between items-center">
                <span>{weekdays[a.weekday]} {mins(a.startMin)}–{mins(a.endMin)}</span>
                <form action={removeAvailability}><input type="hidden" name="id" value={a.id} /><button className="btn-secondary btn-sm">✕</button></form>
              </li>
            ))}
            {avail.length === 0 && <li className="text-[#7a6a5c]">Not set — managers will assume you&apos;re flexible.</li>}
          </ul>
          <form action={addAvailability} className="grid grid-cols-3 gap-2 items-end">
            <div><label className="label">Day</label><select name="weekday" className="input">{weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></div>
            <div><label className="label">From</label><input name="start" type="time" className="input" defaultValue="09:00" /></div>
            <div><label className="label">To</label><input name="end" type="time" className="input" defaultValue="17:00" /></div>
            <div className="col-span-3"><button className="btn-secondary w-full">Add</button></div>
          </form>
        </div>

        <div className="card lg:col-span-2">
          <h2 className="font-semibold mb-3">Open shifts you can claim</h2>
          {openShifts.length === 0 ? <p className="text-sm text-[#7a6a5c]">None right now.</p> : (
            <ul className="divide-y divide-[var(--line)] text-sm">
              {openShifts.map((s) => {
                const claimed = s.claims.some((c) => c.userId === viewer.id);
                return (
                  <li key={s.id} className="py-2 flex items-center justify-between gap-2">
                    <span>{fmtDateTime(s.startsAt)} – {fmtTime(s.endsAt)} <span className="text-[#7a6a5c]">{s.location.name} · {s.position}</span></span>
                    {claimed ? <Badge tone="info">requested</Badge> : <form action={claimShift}><input type="hidden" name="shiftId" value={s.id} /><button className="btn-primary btn-sm">Claim</button></form>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Shell>
  );
}
