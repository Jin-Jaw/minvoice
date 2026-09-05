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
  it('requires invoice number plus exact amount and currency', () => {
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
      detail: 'no exact sent-invoice number, amount, and currency match',
    });
  });

  it('does not treat an Australian dollar symbol as USD', () => {
    expect(
      matchGmailPayment('Payment received for INV-0042: A$1,234.56', [invoice({ currency: 'USD' })]).kind
    ).toBe('ignored');
  });

  it('does not match an invoice number embedded inside a longer token', () => {
    expect(matchGmailPayment('Payment for XINV-0042Z: GBP 1,234.56', [invoice()]).kind).toBe('ignored');
  });

  it('never transitions drafts', () => {
    expect(matchGmailPayment('Payment received for INV-0042: GBP 1,234.56', [invoice({ status: 'draft' })]).kind).toBe('ignored');
  });

  it('requires manual review when more than one invoice matches', () => {
    const duplicate = invoice({ id: 43 });
    expect(matchGmailPayment('Payment received for INV-0042: GBP 1,234.56', [invoice(), duplicate])).toEqual({
      kind: 'review',
      detail: 'multiple exact invoice matches',
    });
  });
});
