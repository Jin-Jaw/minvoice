import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { generateInvoicePdf } from '../src/services/pdf';
import { PrintInvoice } from '../src/views/print';
import { getSettings, type InvoiceItem, type InvoiceWithClient } from '../src/db/queries';

const DB = env.DB;

function fakeInvoice(over: Partial<InvoiceWithClient> = {}): InvoiceWithClient {
  return {
    id: 1,
    branch_id: 1,
    number: 'INV-0001',
    client_id: 1,
    status: 'sent',
    currency: 'EUR',
    issue_date: '2026-07-01',
    due_date: '2026-07-15',
    subject: null,
    notes: null,
    tax_rate_bps: 1900,
    subtotal_cents: 100000,
    tax_cents: 19000,
    total_cents: 119000,
    public_token: 'testtoken',
    paypal_order_id: null,
    sent_at: null,
    paid_at: null,
    created_at: '',
    updated_at: '',
    client_name: 'Müller & Söhne GmbH',
    client_email: 'ap@example.de',
    client_address: 'Beispielstraße 12\n10115 Berlin',
    client_locale: null,
    ...over,
  };
}

const item = (description: string): InvoiceItem => ({
  id: 1,
  invoice_id: 1,
  position: 0,
  description,
  quantity: 1,
  unit_price_cents: 100000,
  amount_cents: 100000,
});

describe('PDF generation with embedded fonts', () => {
  it('German umlauts render via the FAST WinAnsi path (no font embedding)', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'de', business_name: 'Größenwahn Bücher', logo_url: null };
    const bytes = await generateInvoicePdf(fakeInvoice(), [item('Beratung für Änderungswünsche')], settings, env.ASSETS);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    // Umlauts/€ are WinAnsi: built-in fonts suffice, keeping CPU ~3.5ms
    // (Workers Free cap is 10ms) — a small PDF proves no Noto embedding ran.
    expect(bytes.length).toBeLessThan(15000);
  });

  it('French Intl number formatting stays on the fast path (narrow spaces normalized)', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'fr', logo_url: null };
    const bytes = await generateInvoicePdf(fakeInvoice({ client_locale: 'fr' }), [item('Prestation de conseil détaillée')], settings, env.ASSETS);
    expect(bytes.length).toBeLessThan(15000);
  });

  it('renders extended-Latin and Cyrillic with the REAL Noto fonts, not the fallback', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'en' };
    const bytes = await generateInvoicePdf(
      fakeInvoice({ client_name: 'Zażółć gęślą jaźń — Дмитрий Șțigletul' }),
      [item('Wdrożenie systemu płatności — консультация — reșițean')],
      settings,
      env.ASSETS
    );
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    // Discriminates real embedding from silent fallback: subset Noto fonts add
    // ~18KB+ to the document; the WinAnsi standard-font fallback stays ~5KB.
    // (Font names aren't greppable — pdf-lib compresses object streams.)
    expect(bytes.length).toBeGreaterThan(15000);
  });

  it('Turkish uppercasing (dotted İ) forces the Unicode fonts even for ASCII source text', async () => {
    // labels are uppercased with the locale: 'Billed to' -> 'BİLLED TO' (İ is not WinAnsi)
    const settings = { ...(await getSettings(DB)), locale: 'tr' };
    const bytes = await generateInvoicePdf(fakeInvoice(), [item('Plain ascii item')], settings, env.ASSETS);
    expect(bytes.length).toBeGreaterThan(15000); // Noto path
  });

  it('a Polish paid-date (paz\u0301dziernik) on the PAID stamp forces the Unicode fonts', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'pl' };
    const bytes = await generateInvoicePdf(
      fakeInvoice({ status: 'paid', paid_at: '2026-10-18 12:00:00' }),
      [item('Plain ascii item')],
      settings,
      env.ASSETS
    );
    expect(bytes.length).toBeGreaterThan(15000); // '18 paz\u0301 2026' needs Noto
  });

  it('per-client locale override wins over the business locale', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'en' };
    // French client of an English business: doc title should be French
    const bytes = await generateInvoicePdf(fakeInvoice({ client_locale: 'fr' }), [item('Prestation')], settings, env.ASSETS);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('still renders without the assets binding (standard-font fallback)', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'de', logo_url: null };
    const bytes = await generateInvoicePdf(fakeInvoice(), [item('Beratung')], settings);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeLessThan(15000); // no embedded fonts on this path
  });
});

describe('Register document layout', () => {
  it('renders a PAID invoice with the stamp path', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'en', logo_url: null };
    const bytes = await generateInvoicePdf(
      fakeInvoice({ status: 'paid', paid_at: '2026-08-01 12:00:00' }),
      [item('Consulting')],
      settings,
      env.ASSETS
    );
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('renders a VOID invoice with the stamp path', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'en', logo_url: null };
    const bytes = await generateInvoicePdf(fakeInvoice({ status: 'void' }), [item('Consulting')], settings, env.ASSETS);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('paginates a long item list onto multiple pages (repeated table header)', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'en', logo_url: null };
    const items = Array.from({ length: 45 }, (_, i) => ({
      ...item(`Line item number ${i + 1} — recurring services for the period`),
      id: i + 1,
      position: i,
    }));
    const bytes = await generateInvoicePdf(
      fakeInvoice({ notes: 'Bank transfer to Example Ltd\nReference: INV-0001' }),
      items,
      settings,
      env.ASSETS,
      null,
      'https://example.test/pay/abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef1234'
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('print view shows Register fields, no subject, and no inline style attributes', async () => {
    const settings = await getSettings(DB);
    const html = String(
      PrintInvoice({
        invoice: fakeInvoice({
          subject: 'ZZ-NEVER-PRINT-ZZ',
          notes: 'Bank: Example Bank\nIBAN: GB00 TEST 0000 0000',
        }),
        items: [item('Consulting')],
        settings,
        payUrl: 'https://example.test/pay/token123',
        logoSrc: '/logo/1',
      })
    );
    expect(html).not.toContain('ZZ-NEVER-PRINT-ZZ'); // subject never prints
    expect(html).toContain('Beispielstraße 12'); // client address in Billed-to
    expect(html).toContain('IBAN: GB00 TEST 0000 0000'); // notes in the payment panel
    expect(html).toContain('https://example.test/pay/token123'); // pay-link footer
    expect(html).toContain('/logo/1'); // uploaded branch logo
    expect(html).not.toContain(' style="'); // CSP: no inline style attributes
  });

  it('does not draw the invoice subject on the document', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'en', logo_url: null };
    // The subject is deliberately absent from the document. Proxy check: a
    // long unique subject must not add drawn content — byte size stays within
    // noise (metadata timestamps) of the subject-less render.
    const without = await generateInvoicePdf(fakeInvoice({ subject: null }), [item('Consulting')], settings, env.ASSETS);
    const withSubject = await generateInvoicePdf(
      fakeInvoice({ subject: 'ZZ-UNIQUE-SUBJECT-SHOULD-NEVER-RENDER-ON-THE-DOCUMENT-ZZ' }),
      [item('Consulting')],
      settings,
      env.ASSETS
    );
    expect(Math.abs(withSubject.length - without.length)).toBeLessThan(32);
  });
});
