import { getDocumentProxy } from 'unpdf';

export const MAX_EXPENSE_INVOICE_PAGES = 10;
export const EXPENSE_IMPORT_TTL_HOURS = 24;

export type ExpenseInvoiceExtraction = {
  lines: string[];
  pageCount: number;
};

export type ParsedExpenseInvoice = {
  expenseDate: string | null;
  amountCents: number | null;
  taxCents: number | null;
  currency: string | null;
  payee: string | null;
  reference: string | null;
  category: string;
  warnings: string[];
};

type PositionedText = { str: string; x: number; y: number };

function joinLine(parts: string[]): string {
  return parts
    .join(' ')
    .replace(/\s+([,:;%])/g, '$1')
    .replace(/([£€$])\s+(?=\d)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract positioned text from a genuine PDF. Reconstructing visual lines is
 * important: invoice labels and their values are frequently separate PDF text
 * objects, while the convenience text extractor flattens the whole page.
 */
export async function extractExpenseInvoiceText(bytes: Uint8Array): Promise<ExpenseInvoiceExtraction> {
  // PDF.js transfers/detaches its input buffer. Parse a copy so the verified
  // original bytes remain available for the later D1 evidence write.
  const document = await getDocumentProxy(bytes.slice(), { stopAtErrors: true });
  try {
    if (document.numPages > MAX_EXPENSE_INVOICE_PAGES) {
      throw new Error(`Invoice PDFs can contain at most ${MAX_EXPENSE_INVOICE_PAGES} pages.`);
    }

    const lines: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const positioned: PositionedText[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim() || !('transform' in item)) continue;
        positioned.push({ str: item.str.trim(), x: item.transform[4], y: item.transform[5] });
      }
      positioned.sort((a, b) => (Math.abs(b.y - a.y) > 2.25 ? b.y - a.y : a.x - b.x));

      let current: PositionedText[] = [];
      let currentY = Number.NaN;
      const flush = () => {
        if (!current.length) return;
        current.sort((a, b) => a.x - b.x);
        const line = joinLine(current.map((item) => item.str));
        if (line) lines.push(line);
        current = [];
      };
      for (const item of positioned) {
        if (!current.length || Math.abs(item.y - currentY) <= 2.25) {
          current.push(item);
          currentY = Number.isNaN(currentY) ? item.y : (currentY * (current.length - 1) + item.y) / current.length;
        } else {
          flush();
          current = [item];
          currentY = item.y;
        }
      }
      flush();
      page.cleanup();
    }

    const characterCount = lines.reduce((sum, line) => sum + line.length, 0);
    if (characterCount < 20) {
      throw new Error('No selectable invoice text was found. Scanned/image-only PDFs need to be entered manually.');
    }
    if (characterCount > 100_000) throw new Error('The PDF contains too much text to import safely.');
    return { lines, pageCount: document.numPages };
  } finally {
    await document.loadingTask.destroy();
  }
}

const CURRENCY_CODES = ['GBP', 'EUR', 'USD', 'CAD', 'AUD', 'NZD', 'SAR', 'AED'] as const;

function detectCurrency(text: string): string | null {
  const code = text.toUpperCase().match(new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`))?.[1];
  if (code) return code;
  if (text.includes('£')) return 'GBP';
  if (text.includes('€')) return 'EUR';
  if (text.includes('$')) return 'USD';
  return null;
}

function parseMoneyNumber(raw: string): number | null {
  let value = raw
    .toUpperCase()
    .replace(new RegExp(CURRENCY_CODES.join('|'), 'g'), '')
    .replace(/[£€$()\s']/g, '')
    .replace(/[^\d,.-]/g, '');
  if (!value || value === '-') return null;

  const comma = value.lastIndexOf(',');
  const dot = value.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    value = value.replace(thousands, '').replace(decimal, '.');
  } else if (comma >= 0) {
    const digitsAfter = value.length - comma - 1;
    value = digitsAfter === 1 || digitsAfter === 2
      ? value.replace(/\./g, '').replace(/,/g, '.')
      : value.replace(/,/g, '');
  } else if (dot >= 0) {
    const digitsAfter = value.length - dot - 1;
    if (digitsAfter !== 1 && digitsAfter !== 2) value = value.replace(/\./g, '');
    else value = value.replace(/,/g, '');
  }

  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

type MoneyCandidate = { cents: number; currency: string | null };

function moneyCandidates(line: string): MoneyCandidate[] {
  const codePattern = CURRENCY_CODES.join('|');
  const expression = new RegExp(
    `(?:(?:${codePattern})\\s*)?[£€$]?\\s*-?(?:\\d{1,3}(?:[ ,.']\\d{3})+|\\d+)(?:[.,]\\d{1,2})?\\s*(?:\\((?:${codePattern})\\)|(?:${codePattern}))?`,
    'gi'
  );
  const candidates: MoneyCandidate[] = [];
  for (const match of line.matchAll(expression)) {
    const raw = match[0];
    const cents = parseMoneyNumber(raw);
    if (cents === null) continue;
    candidates.push({ cents, currency: detectCurrency(raw) });
  }
  return candidates;
}

const MONTHS = new Map([
  ['january', 1], ['jan', 1], ['february', 2], ['feb', 2], ['march', 3], ['mar', 3],
  ['april', 4], ['apr', 4], ['may', 5], ['june', 6], ['jun', 6], ['july', 7], ['jul', 7],
  ['august', 8], ['aug', 8], ['september', 9], ['sep', 9], ['sept', 9], ['october', 10],
  ['oct', 10], ['november', 11], ['nov', 11], ['december', 12], ['dec', 12],
]);

function isoDate(year: number, month: number, day: number): string | null {
  const result = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === result ? result : null;
}

function parseInvoiceDate(raw: string): string | null {
  const value = raw.trim();
  const named = value.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (named) {
    const month = MONTHS.get(named[1].toLowerCase());
    return month ? isoDate(Number(named[3]), month, Number(named[2])) : null;
  }
  const numeric = value.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
  if (!numeric) return null;
  if (numeric[1].length === 4) return isoDate(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
  // Invoice examples and the application's locale use day-month-year.
  return isoDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
}

function labelledDate(lines: string[]): string | null {
  const dateValue = '([A-Za-z]+\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,4}[-/.]\\d{1,2}[-/.]\\d{1,4})';
  const labels = ['invoice date', 'issue date', 'date'];
  for (const label of labels) {
    const expression = new RegExp(`(?:^|\\b)${label}\\s*:?\\s*${dateValue}`, 'i');
    for (const line of lines) {
      if (label === 'date' && /\bdue\s+date\b/i.test(line)) continue;
      const match = line.match(expression);
      const parsed = match ? parseInvoiceDate(match[1]) : null;
      if (parsed) return parsed;
    }
  }
  return null;
}

function invoiceReference(lines: string[]): string | null {
  for (const line of lines) {
    const labelled = line.match(/\binvoice\s*(?:number|no\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9./_-]*)/i);
    if (labelled) return labelled[1].slice(0, 120);
  }
  for (let index = 0; index < Math.min(lines.length, 15); index++) {
    const standalone = lines[index].match(/^#\s*([A-Z0-9][A-Z0-9./_-]*)$/i);
    if (standalone && lines.slice(Math.max(0, index - 2), index).some((line) => /^invoice\b/i.test(line))) {
      return standalone[1].slice(0, 120);
    }
  }
  return null;
}

function normal(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function likelyPayee(lines: string[], buyerNames: string[]): string | null {
  const buyers = buyerNames.map(normal).filter(Boolean);
  const invalid = /^(?:invoice|tax invoice|bill to|billed to|prepared for|date|due date|balance due|client|customer|page|description|item|total|payment)\b/i;
  for (const line of lines.slice(0, 15)) {
    // Some generators place the issuer and street address on the same visual
    // line, separated by a middle dot. Keep the legal name, not the address.
    const candidate = line.trim().replace(/\s+[·•]\s+(?=[^\n]*\d)/, '\n').split('\n')[0].trim();
    const normalized = normal(candidate);
    if (
      !candidate || candidate.length > 160 || invalid.test(candidate) || /^#/.test(candidate) ||
      !/[A-Za-z]/.test(candidate) || /@|https?:|\b(?:iban|bic|vat|tax id)\b/i.test(candidate) ||
      buyers.some((buyer) => normalized.includes(buyer) || buyer.includes(normalized))
    ) continue;
    return candidate;
  }
  return null;
}

function categoryFor(lines: string[]): string {
  const text = lines.join(' ').toLowerCase();
  if (/\b(subscription|software|hosting|licen[cs]e|saas)\b/.test(text)) return 'Software & services';
  if (/\b(flight|hotel|train|travel|accommodation|taxi)\b/.test(text)) return 'Travel & accommodation';
  if (/\b(marketing|advertis|campaign|promotion)\b/.test(text)) return 'Marketing';
  if (/\b(equipment|hardware|computer|supplies)\b/.test(text)) return 'Equipment & supplies';
  if (/\b(hours?|days?|contractor|talent|vfx|tech art)\b/.test(text)) return 'Employees & contractors';
  return 'Professional fees';
}

function finalTotal(lines: string[]): { amountCents: number | null; currency: string | null } {
  const candidates: Array<{ score: number; order: number; money: MoneyCandidate }> = [];
  lines.forEach((line, order) => {
    const lower = line.toLowerCase();
    if (/\b(sub[ -]?total|total\s+excl|total\s+vat|vat\s+total)\b/.test(lower)) return;
    let score = 0;
    if (/\bgrand\s+total\b/.test(lower)) score = 120;
    else if (/\btotal\s+(?:incl\.?|including)\b/.test(lower)) score = 115;
    else if (/^\s*total\s*:/i.test(line) || /^\s*total\s+/i.test(line)) score = 110;
    else if (/\b(?:amount|total)\s+due\b/.test(lower)) score = 100;
    else if (/\bbalance\s+due\b/.test(lower)) score = 90;
    if (!score) return;
    const amounts = moneyCandidates(line);
    const positive = amounts.filter((amount) => amount.cents > 0);
    const money = positive.at(-1);
    if (money) candidates.push({ score, order, money });
  });
  candidates.sort((a, b) => b.score - a.score || b.order - a.order);
  const selected = candidates[0]?.money;
  const documentCurrency = detectCurrency(lines.join(' '));
  return { amountCents: selected?.cents ?? null, currency: selected?.currency ?? documentCurrency };
}

function includedTax(lines: string[]): number | null {
  for (const line of lines) {
    if (!/\b(?:total\s+vat\s+amount|vat\s+amount|tax(?:\s*\([^)]*\))?)\s*:/i.test(line) &&
        !/\btotal\s+vat\s+amount\b/i.test(line)) continue;
    const amounts = moneyCandidates(line);
    const amount = amounts.at(-1);
    if (amount) return amount.cents;
  }
  return null;
}

/** Deterministic, review-first parser. It never writes an expense itself. */
export function parseExpenseInvoice(lines: string[], buyerNames: string[] = []): ParsedExpenseInvoice {
  const total = finalTotal(lines);
  const expenseDate = labelledDate(lines);
  const payee = likelyPayee(lines, buyerNames);
  const warnings: string[] = [];
  if (!expenseDate) warnings.push('Invoice date was not found. Choose the correct expense date.');
  if (total.amountCents === null) warnings.push('Final total was not found. Enter the total paid.');
  if (!total.currency) warnings.push('Currency was not found. Choose the invoice currency.');
  if (!payee) warnings.push('Supplier name was not found. Enter who was paid.');
  if (lines.join(' ').includes('$') && !/\bUSD\b/i.test(lines.join(' '))) {
    warnings.push('The $ symbol was treated as USD. Change it if this invoice uses another dollar currency.');
  }
  return {
    expenseDate,
    amountCents: total.amountCents,
    taxCents: includedTax(lines),
    currency: total.currency,
    payee,
    reference: invoiceReference(lines),
    category: categoryFor(lines),
    warnings,
  };
}

/** Match an invoice's billed-to/prepared-for text to one of the user's companies. */
export function detectExpenseBranch(lines: string[], branches: Array<{ id: number; name: string }>): number | null {
  const text = normal(lines.join(' '));
  return branches
    .map((branch) => ({ ...branch, normalized: normal(branch.name) }))
    .filter((branch) => branch.normalized && text.includes(branch.normalized))
    .sort((a, b) => b.normalized.length - a.normalized.length)[0]?.id ?? null;
}
