import { describe, expect, it } from 'vitest';
import { createZip, safeZipPart } from './zip';

describe('expense evidence archive', () => {
  it('writes a valid ZIP with UTF-8 file names and stored bytes', () => {
    const zip = createZip([
      { name: 'expenses.csv', bytes: new TextEncoder().encode('paid_to,invoice_status\r\nSupplier,attached\r\n') },
      { name: 'evidence/2026-09-01_1_Supplier/1_invoice.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
    ]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(new TextDecoder().decode(zip)).toContain('expenses.csv');
    expect(new TextDecoder().decode(zip)).toContain('invoice.pdf');
  });

  it('makes attachment path components safe and stable', () => {
    expect(safeZipPart('../../ACME & Sons / invoice 1.pdf')).toBe('ACME-Sons-invoice-1.pdf');
  });
});
