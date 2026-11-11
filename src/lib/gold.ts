// Gold purchases: an expense that also adds whole ounces to the gold holding.

import { formatCents } from './money';

/** Kept out of EXPENSE_CATEGORIES so receipt reading and category pickers never choose it. */
export const GOLD_CATEGORY = 'Gold';
export const GOLD_PAYEE = 'Gold purchase';
export const MAX_GOLD_OUNCES = 1000;

/**
 * ISO 4217 code for one troy ounce of gold. Gold received as income is an
 * income entry in this "currency" at 100 per ounce, so it needs no column of
 * its own and can never be added to a money amount. Money paths reject the
 * code (isSupportedCurrency), so only the gold income form writes it.
 */
export const GOLD_CURRENCY = 'XAU';
const GOLD_UNITS_PER_OUNCE = 100;

export const ouncesToGoldAmount = (ounces: number): number => ounces * GOLD_UNITS_PER_OUNCE;
export const goldAmountToOunces = (amount: number): number => amount / GOLD_UNITS_PER_OUNCE;

/** "3", "3 oz" or "3 ounces" → 3. Whole ounces only. */
export function parseOunces(text: string): number | null {
  const match = text.trim().match(/^(\d{1,4})\s*(?:oz|ounces?)?$/i);
  if (!match) return null;
  const ounces = Number(match[1]);
  return ounces >= 1 && ounces <= MAX_GOLD_OUNCES ? ounces : null;
}

/** "3 oz gold at $4,100.00 per ounce", from the total paid. */
export function goldSummary(ounces: number, totalCents: number, currency: string): string {
  return `${ounces} oz gold at ${formatCents(Math.round(totalCents / ounces), currency)} per ounce`;
}
