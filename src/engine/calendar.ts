// E07 date conversion between calendars, using the ICU calendars built into the JavaScript runtime (Intl).
// Sources often state dates in a non-Gregorian calendar ("18 Dey 1404") and sometimes with a weekday that does not
// agree with the date. Conversion is deterministic and checkable; it is never delegated to a model. The result records
// the stated form beside the converted day so a reviewer can see both.
import { DomainError, invariant } from '../contracts.ts';

/** Calendars whose (year, month, day) order is the order of time, which the conversion search requires. */
export const CALENDARS = ['gregory', 'persian', 'islamic-civil', 'islamic-umalqura', 'islamic-tbla', 'coptic', 'ethiopic', 'indian', 'buddhist', 'roc'] as const;
export type CalendarId = typeof CALENDARS[number];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY = 86_400_000;
const LOW = Date.UTC(1, 0, 1), HIGH = Date.UTC(2999, 11, 31);

type Ymd = { year: number; month: number; day: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(calendar: string, locale = 'en', month: 'numeric' | 'long' = 'numeric'): Intl.DateTimeFormat {
  const key = `${calendar}|${locale}|${month}`;
  let f = formatters.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(`${locale}-u-ca-${calendar}-nu-latn`, { timeZone: 'UTC', year: 'numeric', month, day: 'numeric', era: 'short' });
    invariant(f.resolvedOptions().calendar === calendar, 'unsupported', `The runtime has no ${calendar} calendar`);
    formatters.set(key, f);
  }
  return f;
}
/** The calendar date of a UTC day. `year` is the calendar's own year number (era years for `roc`/`buddhist`). */
export function fromUtc(calendar: CalendarId, ms: number): Ymd {
  const parts = fmt(calendar).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  let year = get('year');
  // Gregorian years before 1 CE are written with era BC; keep astronomical order for the search.
  if (calendar === 'gregory' && parts.find((p) => p.type === 'era')?.value === 'BC') year = 1 - year;
  return { year, month: get('month'), day: get('day') };
}
const cmp = (a: Ymd, b: Ymd): number => a.year - b.year || a.month - b.month || a.day - b.day;

/** Month names a calendar uses in a locale (index 0 = month 1), read from the runtime rather than hard-coded. */
export function monthNames(calendar: CalendarId, locale = 'en'): string[] {
  const f = fmt(calendar, locale, 'long');
  const names: string[] = [];
  // Walk two calendar years from a fixed day; record each month's name the first time it appears.
  for (let ms = Date.UTC(2000, 0, 1); ms < Date.UTC(2002, 6, 1) && names.length < 13; ms += DAY) {
    const ymd = fromUtc(calendar, ms);
    if (names[ymd.month - 1] === undefined) names[ymd.month - 1] = f.formatToParts(new Date(ms)).find((p) => p.type === 'month')?.value ?? '';
  }
  return names;
}
const foldName = (s: string): string => s.normalize('NFKD').replace(/[̀-ًͯ-ٟ‌‍]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Resolves a month given as a number or as a name in any of the listed locales. */
export function monthNumber(calendar: CalendarId, month: number | string, locales: readonly string[] = ['en']): number {
  if (typeof month === 'number') return month;
  if (/^\d{1,2}$/.test(month.trim())) return Number(month.trim());
  const want = foldName(month);
  for (const loc of locales) {
    const i = monthNames(calendar, loc).findIndex((n) => foldName(n) === want);
    if (i >= 0) return i + 1;
  }
  throw new DomainError('invalid_input', `Unknown month "${month.slice(0, 40)}" in the ${calendar} calendar`);
}

export type Conversion = Readonly<{
  calendar: CalendarId; stated: Ymd; gregorian: string; weekday: typeof WEEKDAYS[number];
  statedWeekday: string | null; weekdayMatches: boolean | null; notice: string;
}>;

/**
 * Converts a calendar date to the Gregorian day (YYYY-MM-DD) by binary search over UTC days. Throws when the date does
 * not exist in that calendar (for example day 31 of a 30-day month). When a weekday is stated, reports whether it agrees.
 */
export function toGregorian(input: { calendar: string; year: number; month: number | string; day: number; weekday?: string | null; locales?: readonly string[] }): Conversion {
  const calendar = input.calendar as CalendarId;
  invariant((CALENDARS as readonly string[]).includes(calendar), 'invalid_input', `calendar must be one of: ${CALENDARS.join(', ')}`);
  const month = monthNumber(calendar, input.month, input.locales ?? ['en']);
  const want: Ymd = { year: input.year, month, day: input.day };
  invariant(Number.isInteger(want.year) && Number.isInteger(want.month) && Number.isInteger(want.day) && want.month >= 1 && want.month <= 13 && want.day >= 1 && want.day <= 31, 'invalid_input', 'year, month and day must be whole numbers in range');
  let lo = Math.floor(LOW / DAY), hi = Math.floor(HIGH / DAY);
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (cmp(fromUtc(calendar, mid * DAY), want) < 0) lo = mid + 1; else hi = mid; }
  const got = fromUtc(calendar, lo * DAY);
  invariant(cmp(got, want) === 0, 'invalid_date', `${want.year}-${want.month}-${want.day} does not exist in the ${calendar} calendar`);
  const d = new Date(lo * DAY);
  const weekday = WEEKDAYS[d.getUTCDay()] as typeof WEEKDAYS[number];
  const stated = input.weekday === undefined || input.weekday === null || input.weekday === '' ? null : String(input.weekday).trim().toLowerCase();
  if (stated !== null) invariant((WEEKDAYS as readonly string[]).includes(stated), 'invalid_input', `weekday must be an English weekday name (${WEEKDAYS.join(', ')})`);
  return {
    calendar, stated: want, gregorian: d.toISOString().slice(0, 10), weekday, statedWeekday: stated, weekdayMatches: stated === null ? null : stated === weekday,
    notice: 'Converted with the runtime\'s ICU calendar. A weekday that disagrees with the date means the source is internally inconsistent; neither part is corrected here.',
  };
}

/** The weekday of a Gregorian day, and whether a stated weekday agrees with it. */
export function checkWeekday(gregorian: string, weekday: string): { weekday: string; matches: boolean } {
  invariant(/^\d{4}-\d\d-\d\d$/.test(gregorian) && Number.isFinite(Date.parse(`${gregorian}T00:00:00Z`)), 'invalid_input', 'gregorian must be YYYY-MM-DD');
  const actual = WEEKDAYS[new Date(`${gregorian}T00:00:00Z`).getUTCDay()] as string;
  return { weekday: actual, matches: actual === weekday.trim().toLowerCase() };
}
