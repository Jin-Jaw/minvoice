import { describe, expect, it } from 'vitest';
import {
  addDaysISO,
  formatDateHuman,
  formatTimestamp,
  isValidTimezone,
  monthsBetween,
  shiftMonthYears,
  todayInTz,
} from './dates';

describe('todayInTz', () => {
  it('returns ISO dates', () => {
    expect(todayInTz('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayInTz('America/Los_Angeles')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('formatTimestamp', () => {
  it('converts stored UTC datetimes into the business time zone', () => {
    // 2026-07-01 23:26 UTC == 16:26 in Los Angeles (PDT, UTC-7)
    expect(formatTimestamp('2026-07-01 23:26:25', 'America/Los_Angeles')).toBe('2026-07-01 16:26');
    // and can cross the date line backwards
    expect(formatTimestamp('2026-07-02 06:36:45', 'America/Los_Angeles')).toBe('2026-07-01 23:36');
  });

  it('passes date-only values (backdates) through untouched', () => {
    expect(formatTimestamp('2026-06-30', 'America/Los_Angeles')).toBe('2026-06-30');
  });

  it('leaves unparseable values as-is', () => {
    expect(formatTimestamp('not a date at all', 'UTC')).toBe('not a date at all');
  });
});

describe('formatDateHuman', () => {
  it('renders ISO dates as short human dates', () => {
    expect(formatDateHuman('2026-08-29')).toBe('29 Aug 2026');
    expect(formatDateHuman('2026-09-09')).toBe('9 Sep 2026'); // no zero-padding
    expect(formatDateHuman('2026-01-01')).toBe('1 Jan 2026');
  });

  it('passes non-dates through unchanged', () => {
    expect(formatDateHuman('')).toBe('');
    expect(formatDateHuman('not a date')).toBe('not a date');
    expect(formatDateHuman('2026-08-29 14:00')).toBe('2026-08-29 14:00');
  });
});

describe('addDaysISO', () => {
  it('adds calendar days', () => {
    expect(addDaysISO('2026-07-02', 14)).toBe('2026-07-16');
    expect(addDaysISO('2026-07-31', 1)).toBe('2026-08-01'); // month rollover
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01'); // year rollover
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });
});

describe('monthsBetween', () => {
  it('counts calendar months and ignores the day', () => {
    expect(monthsBetween('2026-08-29', '2026-09-01')).toBe(1);
    expect(monthsBetween('2026-08-01', '2026-08-31')).toBe(0);
    expect(monthsBetween('2026-11-15', '2027-02-01')).toBe(3);
    expect(monthsBetween('2026-09-01', '2026-08-01')).toBe(-1);
  });
});

describe('shiftMonthYears', () => {
  it('moves a monthly line item to the next month', () => {
    expect(shiftMonthYears('Tech art services : August 2026 - £2,500', 1)).toBe(
      'Tech art services : September 2026 - £2,500'
    );
  });

  it('rolls the year over', () => {
    expect(shiftMonthYears('Tech art services : December 2026', 1)).toBe('Tech art services : January 2027');
    expect(shiftMonthYears('Retainer Nov 2026', 3)).toBe('Retainer Feb 2027');
  });

  it('keeps short names, capitals, and punctuation as written', () => {
    expect(shiftMonthYears('Aug 2026', 1)).toBe('Sep 2026');
    expect(shiftMonthYears('Sept. 2026', 1)).toBe('Oct. 2026');
    expect(shiftMonthYears('AUGUST 2026', 1)).toBe('SEPTEMBER 2026');
    expect(shiftMonthYears('april, 2026', 1)).toBe('may, 2026');
    expect(shiftMonthYears('May 2026', 1)).toBe('June 2026');
  });

  it('changes every month in the text', () => {
    expect(shiftMonthYears('July 2026 and August 2026', 2)).toBe('September 2026 and October 2026');
  });

  it('leaves text without a month and year alone', () => {
    expect(shiftMonthYears('We may ship in March', 1)).toBe('We may ship in March');
    expect(shiftMonthYears('Decimal 2026 rework', 1)).toBe('Decimal 2026 rework');
    expect(shiftMonthYears('August 2026', 0)).toBe('August 2026');
  });
});
