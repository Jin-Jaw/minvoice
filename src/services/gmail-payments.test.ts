import { describe, expect, it } from 'vitest';
import { matchGmailPayment, type GmailPaymentCandidate } from './gmail-payments';

const invoice = (overrides: Partial<GmailPaymentCandidate> = {}): GmailPaymentCandidate => ({
  id: 42,
  number: 'INV-0042',
  status: 'sent',
  total_cents: 123456,
  currency: 'GBP',
  ...overrides,
});

describe('matchGmailPayment', () => {
  it('matches an invoice reference with an exact amount and currency', () => {
    expect(matchGmailPayment('Payment received for INV-0042: GBP 1,234.56', [invoice()])).toEqual({
      kind: 'paid',
      invoice: invoice(),
    });
  });

  it('accepts a known currency symbol', () => {
    expect(matchGmailPayment('INV-0042 payment of £1234.56 completed', [invoice()]).kind).toBe('paid');
  });

  it('does not match an amount without its currency', () => {
    expect(matchGmailPayment('INV-0042 payment of 1,234.56 completed', [invoice()])).toEqual({
      kind: 'ignored',
      detail: 'no recognised payment amount and currency',
    });
  });

  it('accepts a currency-converted payment when the invoice reference is present', () => {
    expect(
      matchGmailPayment('Payment received for INV-0042: A$1,234.56', [invoice({ currency: 'USD' })]).kind
    ).toBe('paid');
  });

  it('matches a unique same-currency amount reduced by a small transfer fee without an invoice reference', () => {
    expect(
      matchGmailPayment('Payment initiated from Adhoc Studio Inc: USD 12,165.07', [
        invoice({ total_cents: 1225700, currency: 'USD' }),
      ]).kind
    ).toBe('paid');
  });

  it('matches a converted Venn receipt to its referenced invoice', () => {
    expect(
      matchGmailPayment('Payment received: GBP 198.54. Reference INV-0042', [
        invoice({ total_cents: 27000, currency: 'USD' }),
      ]).kind
    ).toBe('paid');
  });

  it('does not guess a cross-currency match without an invoice reference', () => {
    expect(matchGmailPayment('Payment received: GBP 198.54', [invoice({ total_cents: 27000, currency: 'USD' })]).kind).toBe(
      'ignored'
    );
  });

  it('does not redirect a mismatched invoice reference to another amount-only candidate', () => {
    expect(
      matchGmailPayment('Payment for INV-0042: GBP 500.00', [
        invoice(),
        invoice({ id: 43, number: 'INV-0043', total_cents: 50000 }),
      ])
    ).toEqual({ kind: 'ignored', detail: 'referenced invoice amount exceeds the 1% transfer-fee allowance' });
  });

  it('does not match an invoice number embedded inside a longer token', () => {
    expect(matchGmailPayment('Payment for XINV-0042Z: GBP 1,100.00', [invoice()]).kind).toBe('ignored');
  });

  it('never transitions drafts', () => {
    expect(matchGmailPayment('Payment received for INV-0042: GBP 1,234.56', [invoice({ status: 'draft' })]).kind).toBe('ignored');
  });

  it('requires manual review when more than one invoice matches', () => {
    const duplicate = invoice({ id: 43 });
    expect(matchGmailPayment('Payment received for INV-0042: GBP 1,234.56', [invoice(), duplicate])).toEqual({
      kind: 'review',
      detail: 'multiple invoice numbers in one payment message',
    });
  });

  it('requires review when a fee-adjusted amount could belong to multiple invoices', () => {
    expect(
      matchGmailPayment('Payment received: USD 12,165.07', [
        invoice({ id: 1, total_cents: 1225700, currency: 'USD' }),
        invoice({ id: 2, total_cents: 1220000, currency: 'USD' }),
      ])
    ).toEqual({ kind: 'review', detail: 'payment amount is close to multiple sent invoices' });
  });
});
