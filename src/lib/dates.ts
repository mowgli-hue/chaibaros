import { addDays, format, startOfWeek, endOfWeek, differenceInMinutes } from "date-fns";

export const TZ = "America/Vancouver";

/** Monday-start week containing `d`. */
export function weekRange(d: Date) {
  const start = startOfWeek(d, { weekStartsOn: 1 });
  const end = endOfWeek(d, { weekStartsOn: 1 });
  return { start, end, days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) };
}

export function parseWeek(param?: string | null) {
  if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) {
    const [y, m, dd] = param.split("-").map(Number);
    return new Date(y, m - 1, dd);
  }
  return new Date();
}

export const fmtDay = (d: Date) => format(d, "EEE d MMM");
export const fmtTime = (d: Date) => format(d, "h:mmaaa").replace(":00", "");
export const fmtDate = (d: Date) => format(d, "yyyy-MM-dd");
export const fmtDateTime = (d: Date) => format(d, "EEE d MMM, h:mm a");

export function paidHours(start: Date, end: Date, breakMin: number) {
  return Math.max(0, (differenceInMinutes(end, start) - breakMin) / 60);
}

export function money(cents: number | null | undefined) {
  return ((cents ?? 0) / 100).toLocaleString("en-CA", { style: "currency", currency: "CAD" });
}
