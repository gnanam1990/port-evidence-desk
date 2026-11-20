/** Terminal-local calendar-date arithmetic. Dates are `YYYY-MM-DD` strings. */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

export function isDateString(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isOffsetString(s: unknown): s is string {
  return typeof s === 'string' && OFFSET_RE.test(s);
}

function toUtcDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

export function addDays(date: string, days: number): string {
  return new Date((toUtcDay(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

/** Inclusive day difference: b - a in calendar days. */
export function daysBetween(a: string, b: string): number {
  return toUtcDay(b) - toUtcDay(a);
}

/** Enumerate calendar dates from `from` to `to` inclusive (requires from <= to). */
export function* eachDate(from: string, to: string): Generator<string> {
  for (let d = from; ; d = addDays(d, 1)) {
    yield d;
    if (d === to) return;
  }
}

/** Convert a local date/time with an explicit numeric offset into a UTC instant ISO string. */
export function localToUtc(localDate: string, localTime: string | null, offset: string): string {
  const time = localTime && /^\d{2}:\d{2}(:\d{2})?$/.test(localTime) ? localTime : '00:00:00';
  const withSecs = time.length === 5 ? `${time}:00` : time;
  const ms = Date.parse(`${localDate}T${withSecs}${offset}`);
  if (Number.isNaN(ms)) throw new Error(`invalid local timestamp ${localDate} ${time} ${offset}`);
  return new Date(ms).toISOString();
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** `a <= b` on ISO calendar dates or instants (lexicographic works for both). */
export function dateLte(a: string, b: string): boolean {
  return a <= b;
}
