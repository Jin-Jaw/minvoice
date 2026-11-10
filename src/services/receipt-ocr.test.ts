import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BANK_ADVICE_MODEL,
  parseIncomeFields,
  parseReceiptFields,
  readIncomeImage,
  readReceiptImage,
  RECEIPT_MODEL,
} from './receipt-ocr';

// Dates read from a photo must be recent, so the fixtures below need a fixed today.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-10T12:00:00Z') });
});
afterAll(() => {
  vi.useRealTimers();
});

describe('parseReceiptFields', () => {
  it('maps a complete model answer', () => {
    const parsed = parseReceiptFields({
      total: 12.4,
      currency: 'gbp',
      tax: 2.07,
      supplier: '  Pret A Manger ',
      date: '2026-09-20',
      reference: 'R-1182',
      category: 'Travel & accommodation',
    });
    expect(parsed).toEqual({
      expenseDate: '2026-09-20',
      amountCents: 1240,
      taxCents: 207,
      currency: 'GBP',
      payee: 'Pret A Manger',
      reference: 'R-1182',
      category: 'Travel & accommodation',
      warnings: [],
    });
  });

  it('accepts JSON text wrapped in prose or code fences', () => {
    const parsed = parseReceiptFields('Here you go:\n```json\n{"total": "£1,050.00", "currency": "GBP"}\n```');
    expect(parsed.amountCents).toBe(105000);
    expect(parsed.currency).toBe('GBP');
  });

  it('drops unreadable or implausible values', () => {
    const parsed = parseReceiptFields({
      total: 0,
      currency: 'pounds',
      tax: 5,
      supplier: 'null',
      date: '2099-01-01',
      category: 'Snacks',
    });
    expect(parsed.amountCents).toBeNull();
    expect(parsed.currency).toBeNull();
    expect(parsed.payee).toBeNull();
    expect(parsed.expenseDate).toBeNull();
    expect(parsed.category).toBe('Other');
    expect(parsed.warnings).toHaveLength(3);
  });

  it('takes the amount received on a bank advice, not the converted amount, and no tax', () => {
    // An LGB Bank cash deposit advice: USD 1,341.89 received, sent on as GBP 1,000.00.
    const parsed = parseReceiptFields({
      total: 1000,
      currency: 'GBP',
      tax: 7.05,
      supplier: 'LGB Bank',
      date: '2026-10-13',
      reference: '00132',
      received: 1341.89,
      received_currency: 'USD',
    });
    expect(parsed).toMatchObject({ amountCents: 134189, currency: 'USD', taxCents: null, expenseDate: '2026-10-13' });
    // Without a currency on that line, none is guessed; the bot falls back to the company's.
    expect(parseReceiptFields({ total: 1000, currency: 'GBP', received: 1341.89 }).currency).toBeNull();
  });

  it('ignores tax that is not smaller than the total', () => {
    expect(parseReceiptFields({ total: 10, tax: 10 }).taxCents).toBeNull();
  });

  it('returns an empty read for garbage', () => {
    expect(parseReceiptFields('no json here').amountCents).toBeNull();
    expect(parseReceiptFields(null).amountCents).toBeNull();
  });
});

describe('readReceiptImage', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

  it('sends the image as a data URL and parses the response', async () => {
    let request: any;
    const ai = {
      run: async (_model: string, input: unknown) => {
        request = input;
        return { response: { total: 8.5, currency: 'EUR', supplier: 'Café' } };
      },
    } as unknown as Ai;
    const parsed = await readReceiptImage(ai, jpeg, 'image/jpeg');
    expect(parsed.amountCents).toBe(850);
    expect(parsed.currency).toBe('EUR');
    const image = request.messages[1].content[1];
    expect(image.image_url.url).toBe('data:image/jpeg;base64,/9j/4A==');
  });

  it('asks Mistral for the amount received on a bank advice, and only then', async () => {
    const models: string[] = [];
    const answers: Record<string, unknown> = {
      [RECEIPT_MODEL]: { total: 1000, currency: 'GBP', supplier: 'LGB Bank', date: '2026-10-13', received: 1332.5, received_currency: 'USD' },
      [BANK_ADVICE_MODEL]: { total: null, currency: null, received: 1341.89, received_currency: 'USD' },
    };
    const ai = {
      run: async (model: string) => {
        models.push(model);
        return { response: answers[model] };
      },
    } as unknown as Ai;
    expect(await readReceiptImage(ai, jpeg, 'image/jpeg')).toMatchObject({
      amountCents: 134189,
      currency: 'USD',
      payee: 'LGB Bank',
      expenseDate: '2026-10-13',
    });
    expect(models).toEqual([RECEIPT_MODEL, BANK_ADVICE_MODEL]);

    // An ordinary receipt has no amount received, so Mistral is not asked.
    models.length = 0;
    answers[RECEIPT_MODEL] = { total: 22.96, currency: 'USD', tax: 3.83, received: null };
    expect((await readReceiptImage(ai, jpeg, 'image/jpeg')).amountCents).toBe(2296);
    expect(models).toEqual([RECEIPT_MODEL]);

    // When Mistral reads no amount received, Llama's read stands.
    answers[RECEIPT_MODEL] = { total: 1000, currency: 'GBP', received: 1341.89, received_currency: 'USD' };
    answers[BANK_ADVICE_MODEL] = { received: null };
    expect((await readReceiptImage(ai, jpeg, 'image/jpeg')).amountCents).toBe(134189);
  });

  it('never throws when the model fails or is missing', async () => {
    const failing = { run: async () => { throw new Error('boom'); } } as unknown as Ai;
    expect((await readReceiptImage(failing, jpeg, 'image/jpeg')).amountCents).toBeNull();
    expect((await readReceiptImage(undefined, jpeg, 'image/jpeg')).amountCents).toBeNull();
  });
});

describe('parseIncomeFields', () => {
  it('offers the paid amount first and the gross amount when it differs', () => {
    expect(parseIncomeFields({ paid: 267.6, gross: 1200, currency: 'gbp', date: '2026-09-29' })).toEqual({
      options: [
        { kind: 'paid', cents: 26760, currency: 'GBP' },
        { kind: 'gross', cents: 120000, currency: 'GBP' },
      ],
      date: '2026-09-29',
    });
    expect(parseIncomeFields('{"paid": 950, "gross": 950}').options).toEqual([{ kind: 'paid', cents: 95000, currency: null }]);
  });

  it('reads a bank receipt: the net amount after commission first, its reference and a slashed date', () => {
    // What the model returned for a BLOM Bank receipt: USD 12,048.00 less 48.00 commission.
    expect(
      parseIncomeFields({ paid: 12000, gross: 12048, currency: 'USD', date: '2026/10/13', reference: '024/02/353/1659133/1/3' })
    ).toEqual({
      options: [
        { kind: 'paid', cents: 1200000, currency: 'USD' },
        { kind: 'gross', cents: 1204800, currency: 'USD' },
      ],
      date: '2026-10-13',
      reference: '024/02/353/1659133/1/3',
    });
  });

  it('drops a date over a year old as a misread year', () => {
    // A BLOM Bank receipt dated 2026/11/10, photographed on its side, read as 2020.
    expect(parseIncomeFields({ paid: 12300, currency: 'USD', date: '2020/11/10' }).date).toBeNull();
    expect(parseIncomeFields({ paid: 12300, currency: 'USD', date: '2025-11-12' }).date).toBe('2025-11-12');
    expect(parseReceiptFields({ total: 5, date: '2025-11-08' }).expenseDate).toBeNull();
  });

  it('offers nothing when the model fails', async () => {
    const failing = { run: async () => { throw new Error('boom'); } } as unknown as Ai;
    expect(await readIncomeImage(failing, new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg')).toEqual({ options: [], date: null });
  });
});
