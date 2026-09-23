// Read the key fields from a receipt/invoice photo with a Workers AI vision
// model. The result is only ever a suggestion: the bot always asks the user
// to confirm or correct the amount before an expense is written.

import type { ParsedExpenseInvoice } from '../lib/expense-invoice-import';
import { EXPENSE_CATEGORIES } from '../lib/expenses';
import { isSupportedCurrency } from '../lib/money';

export const RECEIPT_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

export type ReceiptImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const PROMPT = [
  'You read receipts and supplier invoices for bookkeeping.',
  'Return JSON only, with these keys:',
  '- total: the final amount actually paid (after tax and discounts) as a plain number, e.g. 12.4. Not the subtotal, tax, change or tip line alone. null if unreadable.',
  '- currency: ISO 4217 code (GBP for £, EUR for €, USD for $ unless another dollar is stated). null if unknown.',
  '- tax: total VAT/sales tax as a plain number, or null.',
  '- supplier: the business that was paid, as printed. null if unknown.',
  '- date: the purchase/invoice date as YYYY-MM-DD, or null.',
  '- reference: receipt or invoice number, or null.',
  `- category: one of ${EXPENSE_CATEGORIES.map((c) => JSON.stringify(c)).join(', ')}.`,
  'Never guess a number you cannot read.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    total: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    tax: { type: ['number', 'null'] },
    supplier: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    reference: { type: ['string', 'null'] },
    category: { type: ['string', 'null'] },
  },
  required: ['total', 'currency', 'tax', 'supplier', 'date', 'reference', 'category'],
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function amountToCents(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.replace(/[^\d.-]/g, '')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 100_000_000) return null;
  return Math.round(n * 100);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned && cleaned.toLowerCase() !== 'null' ? cleaned.slice(0, max) : null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  // A receipt from the future (or last century) is a misread, not a date.
  const year = parsed.getUTCFullYear();
  if (year < 2000 || parsed.getTime() > Date.now() + 2 * 86_400_000) return null;
  return value;
}

/** Model output (object or JSON text, possibly fenced) → the importer's parsed shape. */
export function parseReceiptFields(raw: unknown): ParsedExpenseInvoice {
  let fields: Record<string, unknown> = {};
  if (raw && typeof raw === 'object') {
    fields = raw as Record<string, unknown>;
  } else if (typeof raw === 'string') {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        fields = JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        fields = {};
      }
    }
  }

  const code = text(fields.currency, 10)?.toUpperCase() ?? null;
  const currency = code && /^[A-Z]{3}$/.test(code) && isSupportedCurrency(code) ? code : null;
  const amountCents = amountToCents(fields.total);
  let taxCents = amountToCents(fields.tax);
  if (taxCents !== null && amountCents !== null && taxCents >= amountCents) taxCents = null;
  const category = text(fields.category, 60);
  const payee = text(fields.supplier, 120);
  const expenseDate = isoDate(fields.date);

  const warnings: string[] = [];
  if (amountCents === null) warnings.push('The total paid could not be read.');
  if (!payee) warnings.push('The supplier name could not be read.');
  if (!expenseDate) warnings.push('The date could not be read; today is used.');
  return {
    expenseDate,
    amountCents,
    taxCents,
    currency,
    payee,
    reference: text(fields.reference, 80),
    category: category && (EXPENSE_CATEGORIES as readonly string[]).includes(category) ? category : 'Other',
    warnings,
  };
}

/**
 * Never throws: any model or network failure returns an empty read so the
 * bot falls back to asking for the amount.
 */
export async function readReceiptImage(
  ai: Ai | undefined,
  bytes: Uint8Array,
  mime: ReceiptImageMime
): Promise<ParsedExpenseInvoice> {
  if (!ai) return parseReceiptFields(null);
  try {
    const result = (await ai.run(RECEIPT_MODEL as Parameters<Ai['run']>[0], {
      messages: [
        { role: 'system', content: PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the fields from this receipt.' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${toBase64(bytes)}` } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
      max_tokens: 300,
      temperature: 0,
    } as never)) as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
    // Workers AI returns the JSON in `response`; the OpenAI-style copy is a fallback.
    return parseReceiptFields(result?.response ?? result?.choices?.[0]?.message?.content ?? null);
  } catch (error) {
    console.error(JSON.stringify({ event: 'receipt_ocr_failed', error: String(error) }));
    return parseReceiptFields(null);
  }
}
