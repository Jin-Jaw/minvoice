import { describe, expect, it } from 'vitest';
import { invoicePdfFilename } from '../src/lib/invoice-filename';

describe('invoicePdfFilename', () => {
  it('uses the exact JinJawLTD prefix for branch 1', () => {
    expect(invoicePdfFilename(1, '2026-08-29')).toBe('JinJawLTD_Invoice_August_2026.pdf');
  });

  it('uses the exact JinJawArabiaSARL prefix for branch 2', () => {
    expect(invoicePdfFilename(2, '2027-01-03')).toBe('JinJawArabiaSARL_Invoice_January_2027.pdf');
  });

  it('has a deterministic fallback for malformed legacy data', () => {
    expect(invoicePdfFilename(999, 'not-a-date')).toBe(
      'Company_Invoice_Unknown_Month_Unknown_Year.pdf'
    );
  });
});
