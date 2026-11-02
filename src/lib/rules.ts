import { differenceInMinutes, format } from "date-fns";
import type { Shift } from "@/db/schema";

export type Warning = { level: "warn" | "error"; shiftId?: string; userId?: string | null; message: string };

type Avail = { userId: string; weekday: number; startMin: number; endMin: number };

/**
 * BC Employment Standards checks applied to a week of shifts:
 * - daily overtime: >8h at 1.5x, >12h at 2x (we warn at >8, error at >12)
 * - weekly overtime: >40h
 * - meal break: 30 min unpaid after 5 consecutive hours
 * - rest: <8h between shifts (warn)
 * - overlapping shifts for one person (error)
 * - outside stated availability (warn)
 */
export function checkWeek(shifts: Shift[], availability: Avail[], names: Record<string, string>): Warning[] {
  const out: Warning[] = [];
  const byUser = new Map<string, Shift[]>();
  for (const s of shifts) {
    if (s.status === "cancelled") continue;
    if (!s.userId) continue;
    byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
  }
  const hours = (s: Shift) => Math.max(0, (differenceInMinutes(s.endsAt, s.startsAt) - s.breakMin) / 60);
  const span = (s: Shift) => differenceInMinutes(s.endsAt, s.startsAt) / 60;

  for (const [userId, list] of byUser) {
    const name = names[userId] ?? "Staff";
    list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    let weekHours = 0;
    const dayHours = new Map<string, number>();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const h = hours(s);
      weekHours += h;
      const day = format(s.startsAt, "yyyy-MM-dd");
      dayHours.set(day, (dayHours.get(day) ?? 0) + h);
      if (span(s) > 5 && s.breakMin < 30) out.push({ level: "warn", shiftId: s.id, userId, message: `${name}: ${format(s.startsAt, "EEE")} shift over 5h needs a 30-min break` });
      const next = list[i + 1];
      if (next) {
        if (next.startsAt < s.endsAt) out.push({ level: "error", shiftId: next.id, userId, message: `${name}: overlapping shifts on ${format(s.startsAt, "EEE d MMM")}` });
        else if (differenceInMinutes(next.startsAt, s.endsAt) < 8 * 60) out.push({ level: "warn", shiftId: next.id, userId, message: `${name}: less than 8h rest before ${format(next.startsAt, "EEE h:mma")}` });
      }
      const av = availability.filter((a) => a.userId === userId && a.weekday === s.startsAt.getDay());
      if (av.length) {
        const sm = s.startsAt.getHours() * 60 + s.startsAt.getMinutes();
        const em = s.endsAt.getHours() * 60 + s.endsAt.getMinutes() || 24 * 60;
        const fits = av.some((a) => a.startMin <= sm && a.endMin >= em);
        if (!fits) out.push({ level: "warn", shiftId: s.id, userId, message: `${name}: ${format(s.startsAt, "EEE")} shift is outside their availability` });
      }
    }
    for (const [day, h] of dayHours) {
      if (h > 12) out.push({ level: "error", userId, message: `${name}: ${h.toFixed(1)}h on ${day} — double time after 12h` });
      else if (h > 8) out.push({ level: "warn", userId, message: `${name}: ${h.toFixed(1)}h on ${day} — overtime after 8h` });
    }
    if (weekHours > 40) out.push({ level: "warn", userId, message: `${name}: ${weekHours.toFixed(1)}h this week — weekly overtime after 40h` });
  }
  return out;
}

/** Labour cost of a set of shifts given hourly rates, in cents. Overtime priced per BC rules per day. */
export function labourCostCents(shifts: Shift[], rates: Record<string, number | null | undefined>) {
  const byUserDay = new Map<string, number>();
  let cents = 0;
  for (const s of shifts) {
    if (!s.userId || s.status === "cancelled") continue;
    const rate = rates[s.userId];
    if (!rate) continue;
    const h = Math.max(0, (differenceInMinutes(s.endsAt, s.startsAt) - s.breakMin) / 60);
    const key = `${s.userId}:${format(s.startsAt, "yyyy-MM-dd")}`;
    const before = byUserDay.get(key) ?? 0;
    const after = before + h;
    byUserDay.set(key, after);
    const reg = Math.max(0, Math.min(after, 8) - Math.min(before, 8));
    const ot = Math.max(0, Math.min(after, 12) - Math.max(before, 8));
    const dt = Math.max(0, after - Math.max(before, 12));
    cents += Math.round(rate * (reg + ot * 1.5 + dt * 2));
  }
  return cents;
}
