import { describe, expect, it } from 'vitest';
import { invoicePdfFilename } from '../src/lib/invoice-filename';

describe('invoicePdfFilename', () => {
  it('uses the company branch, English issue month, and year', () => {
    expect(invoicePdfFilename('Jin & Jaw Register', '2026-08-29')).toBe(
      'Jin_and_Jaw_Register_Invoice_August_2026.pdf'
    );
  });

  it('removes unsafe filename characters and diacritics', () => {
    expect(invoicePdfFilename(' Résvr / London: East? ', '2027-01-03')).toBe(
      'Resvr_London_East_Invoice_January_2027.pdf'
    );
  });

  it('has a deterministic fallback for malformed legacy data', () => {
    expect(invoicePdfFilename('', 'not-a-date')).toBe(
      'Company_Invoice_Unknown_Month_Unknown_Year.pdf'
    );
  });
});
