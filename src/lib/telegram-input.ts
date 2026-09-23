// Parsing for the free-text replies the Telegram bot accepts.

import { isSupportedCurrency } from './money';

export type LineItemInput = { description: string; quantity: number; unit_price_cents: number };

/** "12.40", "£12.40", "1,250", "1200 EUR" → cents (+ optional currency). */
export function parseMoneyReply(text: string): { cents: number; currency: string | null } | null {
  const match = text.trim().match(/^([£€$]?\s*-?[\d,]*\.?\d+)\s*([A-Za-z]{3})?$/);
  if (!match) return null;
  const numeric = match[1].replace(/[£€$,\s]/g, '');
  if (!/^-?\d*\.?\d{0,2}$/.test(numeric)) return null;
  const value = Number(numeric);
  if (!Number.isFinite(value) || value <= 0 || value > 100_000_000) return null;
  const currency = match[2]?.toUpperCase() ?? null;
  if (currency && !isSupportedCurrency(currency)) return null;
  return { cents: Math.round(value * 100), currency };
}

/**
 * One invoice line from a single message:
 *   "Tech art support - 2500"
 *   "Shader work - 3 x 450"
 *   "Rigging: 2.5 x 400"
 *   "Retainer"               (price = the client's default rate)
 */
export function parseLineItem(text: string, defaultUnitPriceCents: number | null): LineItemInput | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const priced = cleaned.match(
    // A dash separator needs a space before it so "Sprint 2026-09" stays a description.
    /^(.+?)(?:\s+[-–—]|\s*:)\s*(?:(\d+(?:\.\d+)?)\s*[x×*]\s*)?([£€$]?\s*[\d,]*\.?\d+)$/i
  );
  if (priced) {
    const description = priced[1].trim();
    const quantity = priced[2] ? Number(priced[2]) : 1;
    const price = parseMoneyReply(priced[3]);
    if (!description || description.length > 500 || !price) return null;
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100_000) return null;
    return { description, quantity, unit_price_cents: price.cents };
  }
  if (defaultUnitPriceCents && defaultUnitPriceCents > 0 && cleaned.length <= 500) {
    return { description: cleaned, quantity: 1, unit_price_cents: defaultUnitPriceCents };
  }
  return null;
}
