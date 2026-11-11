// Gold purchases: an expense that also adds whole ounces to the gold holding.

import { formatCents } from './money';

/** Kept out of EXPENSE_CATEGORIES so receipt reading and category pickers never choose it. */
export const GOLD_CATEGORY = 'Gold';
export const GOLD_PAYEE = 'Gold purchase';
export const MAX_GOLD_OUNCES = 1000;

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
