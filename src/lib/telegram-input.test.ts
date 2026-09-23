import { describe, expect, it } from 'vitest';
import { parseLineItem, parseMoneyReply } from './telegram-input';

describe('parseMoneyReply', () => {
  it('reads plain and symbol amounts', () => {
    expect(parseMoneyReply('12.40')).toEqual({ cents: 1240, currency: null });
    expect(parseMoneyReply('£12.40')).toEqual({ cents: 1240, currency: null });
    expect(parseMoneyReply('1,250')).toEqual({ cents: 125000, currency: null });
  });

  it('reads a trailing currency code', () => {
    expect(parseMoneyReply('1200 eur')).toEqual({ cents: 120000, currency: 'EUR' });
  });

  it('rejects zero, negatives, garbage and malformed currencies', () => {
    expect(parseMoneyReply('0')).toBeNull();
    expect(parseMoneyReply('-5')).toBeNull();
    expect(parseMoneyReply('twelve')).toBeNull();
    expect(parseMoneyReply('12.345')).toBeNull();
    expect(parseMoneyReply('10 EURO')).toBeNull();
  });
});

describe('parseLineItem', () => {
  it('reads "description - price"', () => {
    expect(parseLineItem('Tech art support - 2500', null)).toEqual({
      description: 'Tech art support',
      quantity: 1,
      unit_price_cents: 250000,
    });
  });

  it('reads a quantity', () => {
    expect(parseLineItem('Shader work - 3 x 450', null)).toEqual({
      description: 'Shader work',
      quantity: 3,
      unit_price_cents: 45000,
    });
    expect(parseLineItem('Rigging: 2.5 × £400.50', null)).toEqual({
      description: 'Rigging',
      quantity: 2.5,
      unit_price_cents: 40050,
    });
  });

  it('keeps hyphens inside the description', () => {
    expect(parseLineItem('Tech-art pass - 900', null)?.description).toBe('Tech-art pass');
    expect(parseLineItem('Sprint 2026-09', null)).toBeNull();
  });

  it('falls back to the default rate for a bare description', () => {
    expect(parseLineItem('Monthly retainer', 150000)).toEqual({
      description: 'Monthly retainer',
      quantity: 1,
      unit_price_cents: 150000,
    });
  });

  it('rejects a bare description with no default rate', () => {
    expect(parseLineItem('Monthly retainer', null)).toBeNull();
    expect(parseLineItem('   ', 1000)).toBeNull();
  });
});
