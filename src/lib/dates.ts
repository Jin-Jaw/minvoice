/** Today's date (YYYY-MM-DD) in an IANA time zone. en-CA gives ISO format. */
export function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Render a YYYY-MM-DD date as "29 Aug 2026" for the admin UI. Anything that
 * doesn't parse (or is empty) passes through unchanged.
 */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDateHuman(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  // Fixed month table, not Intl — locales disagree on short names (en-GB says "Sept")
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Calendar months from one YYYY-MM-DD date to another; the day is ignored. */
export function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

const MONTH_YEAR =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(\.?,?\s+)(\d{4})\b/gi;

/**
 * Move every "Month YYYY" in the text forward by N months and keep how it was
 * written: "August 2026" becomes "September 2026" and "DEC 2026" becomes
 * "JAN 2027". A month name without a year is left alone, so "may" in a
 * sentence never changes.
 */
export function shiftMonthYears(text: string, months: number): string {
  if (!months) return text;
  return text.replace(MONTH_YEAR, (_match, name: string, gap: string, year: string) => {
    const index = MONTHS_SHORT.findIndex((m) => m.toLowerCase() === name.slice(0, 3).toLowerCase());
    const total = Number(year) * 12 + index + months;
    const next = ((total % 12) + 12) % 12;
    const long = name.length > 4 || /^(may|june|july)$/i.test(name);
    let word = long ? MONTHS_LONG[next] : MONTHS_SHORT[next];
    if (name === name.toUpperCase()) word = word.toUpperCase();
    else if (name === name.toLowerCase()) word = word.toLowerCase();
    return `${word}${gap}${Math.floor(total / 12)}`;
  });
}

/** Add N days to a YYYY-MM-DD date string (calendar math, DST-proof via UTC). */
export function addDaysISO(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Render a stored UTC timestamp ("YYYY-MM-DD HH:MM:SS") in the business time
 * zone as "YYYY-MM-DD HH:MM". Date-only values (backdates) pass through.
 */
export function formatTimestamp(at: string, tz: string): string {
  if (at.length <= 10) return at;
  const d = new Date(at.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return at;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${date} ${time}`;
}
