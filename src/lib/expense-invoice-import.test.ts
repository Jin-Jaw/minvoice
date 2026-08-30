import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  detectExpenseBranch,
  extractExpenseInvoiceText,
  parseExpenseInvoice,
} from './expense-invoice-import';

describe('expense invoice extraction', () => {
  it('reconstructs labelled fields that are separate positioned PDF objects', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([595, 842]);
    page.drawText('Example Supplier Ltd', { x: 40, y: 790, size: 12, font });
    page.drawText('Invoice Date:', { x: 40, y: 740, size: 10, font });
    page.drawText('August 14, 2026', { x: 150, y: 740, size: 10, font });
    page.drawText('GRAND TOTAL', { x: 350, y: 200, size: 10, font });
    page.drawText('EUR 2,400.00', { x: 460, y: 200, size: 10, font });

    const extracted = await extractExpenseInvoiceText(await pdf.save());
    expect(extracted.pageCount).toBe(1);
    expect(extracted.lines).toContain('Invoice Date: August 14, 2026');
    expect(extracted.lines).toContain('GRAND TOTAL EUR 2,400.00');
  });

  it('rejects image-only and excessive-page documents', async () => {
    const blank = await PDFDocument.create();
    blank.addPage();
    await expect(extractExpenseInvoiceText(await blank.save())).rejects.toThrow('No selectable invoice text');

    const long = await PDFDocument.create();
    for (let index = 0; index < 11; index++) long.addPage();
    await expect(extractExpenseInvoiceText(await long.save())).rejects.toThrow('at most 10 pages');
  });
});

describe('expense invoice parser', () => {
  it('parses the Heaven and Hell European invoice format and billed company', () => {
    const lines = [
      'Invoice',
      'Heaven and Hell Games UG (haftungsbeschränkt)',
      'Partwitzer Straße 30',
      'Jin&Jaw Arabia S.A.R.L',
      'Invoice number RE-2026-019',
      'Issue date 14-08-2026',
      'Tech Art Services - Dalibor 48 hours €50.00 0 % €2,400.00',
      'Total excl. VAT €2,400.00',
      'Total VAT amount €0.00',
      'Total incl. VAT €2,400.00',
    ];
    expect(parseExpenseInvoice(lines, ['Jin&Jaw LTD', 'Jin&Jaw Arabia S.A.R.L'])).toEqual({
      expenseDate: '2026-08-14',
      amountCents: 240000,
      taxCents: 0,
      currency: 'EUR',
      payee: 'Heaven and Hell Games UG (haftungsbeschränkt)',
      reference: 'RE-2026-019',
      category: 'Employees & contractors',
      warnings: [],
    });
    expect(detectExpenseBranch(lines, [
      { id: 1, name: 'Jin&Jaw LTD' },
      { id: 2, name: 'Jin&Jaw Arabia S.A.R.L' },
    ])).toBe(2);
  });

  it('parses the Invoice 003 layout without mistaking subtotal, tax, or due date for final values', () => {
    const lines = [
      'Derja Ferman Sulevani',
      'INVOICE',
      '# 003',
      'Bill To: Jin&Jaw Ltd',
      'Date: Jul 1, 2026',
      'Due Date: Aug 31, 2026',
      'Balance Due: £1,000.00',
      'Production - Talent Hiring 1 £1,000.00 £1,000.00',
      'Subtotal: £1,000.00',
      'Tax (0%): £0.00',
      'Total: £1,000.00',
    ];
    expect(parseExpenseInvoice(lines, ['Jin&Jaw Ltd'])).toEqual({
      expenseDate: '2026-07-01',
      amountCents: 100000,
      taxCents: 0,
      currency: 'GBP',
      payee: 'Derja Ferman Sulevani',
      reference: '003',
      category: 'Employees & contractors',
      warnings: [],
    });
  });

  it('parses the free-form Shady invoice with its explicit USD marker', () => {
    const lines = [
      'Shady Tantawy',
      'INVOICE',
      'Invoice Date: April 30, 2026',
      'Prepared for Jin&Jaw LTD',
      'Tech Art & VFX work 14 $320/day $4480',
      '1/4/2026 to 30/4/2026 (14 days)',
      'GRAND TOTAL $4480 (USD)',
    ];
    expect(parseExpenseInvoice(lines, ['Jin&Jaw LTD'])).toEqual({
      expenseDate: '2026-04-30',
      amountCents: 448000,
      taxCents: null,
      currency: 'USD',
      payee: 'Shady Tantawy',
      reference: null,
      category: 'Employees & contractors',
      warnings: [],
    });
  });

  it('handles continental separators and requires review when core labels are absent', () => {
    expect(parseExpenseInvoice(['Consulting GmbH', 'Invoice date: 30.08.2026', 'Grand total EUR 1.234,56'])).toMatchObject({
      expenseDate: '2026-08-30',
      amountCents: 123456,
      currency: 'EUR',
      payee: 'Consulting GmbH',
    });
    expect(parseExpenseInvoice(['INVOICE', 'TOTAL'], ['Jin&Jaw LTD']).warnings).toEqual([
      'Invoice date was not found. Choose the correct expense date.',
      'Final total was not found. Enter the total paid.',
      'Currency was not found. Choose the invoice currency.',
      'Supplier name was not found. Enter who was paid.',
    ]);
  });
});
