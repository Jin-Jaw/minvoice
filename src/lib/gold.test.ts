import { describe, expect, it } from 'vitest';
import { goldSummary, parseOunces } from './gold';

describe('parseOunces', () => {
  it('reads whole ounces with or without a unit', () => {
    expect(parseOunces('3')).toBe(3);
    expect(parseOunces(' 12 oz ')).toBe(12);
    expect(parseOunces('1 ounce')).toBe(1);
    expect(parseOunces('5 Ounces')).toBe(5);
  });

  it('rejects zero, fractions, text and counts over the limit', () => {
    expect(parseOunces('0')).toBeNull();
    expect(parseOunces('2.5')).toBeNull();
    expect(parseOunces('three')).toBeNull();
    expect(parseOunces('1001')).toBeNull();
    expect(parseOunces('-2')).toBeNull();
  });
});

describe('goldSummary', () => {
  it('shows the price per ounce from the total', () => {
    expect(goldSummary(3, 1_230_000, 'USD')).toBe('3 oz gold at $4,100.00 per ounce');
    expect(goldSummary(1, 410_050, 'USD')).toBe('1 oz gold at $4,100.50 per ounce');
  });
});
