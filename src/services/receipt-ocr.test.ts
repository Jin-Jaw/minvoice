import { describe, expect, it } from 'vitest';
import { parseReceiptFields, readReceiptImage } from './receipt-ocr';

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

  it('never throws when the model fails or is missing', async () => {
    const failing = { run: async () => { throw new Error('boom'); } } as unknown as Ai;
    expect((await readReceiptImage(failing, jpeg, 'image/jpeg')).amountCents).toBeNull();
    expect((await readReceiptImage(undefined, jpeg, 'image/jpeg')).amountCents).toBeNull();
  });
});
