import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSettings, type InvoiceWithClient } from '../src/db/queries';
import { sendInvoiceEmail, sendInvoiceEmailToClientAndOwner, sendTestEmail } from '../src/services/email';
import { isBoxed, unbox } from '../src/lib/secretbox';
import { en } from '../src/lib/strings/en';

const DB = env.DB;
const TEST_MASTER_KEY = 'integration-test-master-key-0123456789abcdef';

beforeEach(async () => {
  await DB.prepare(
    `UPDATE settings SET email_provider = 'cloudflare', email_from = 'contact@jin-jaw.co.uk',
     setup_complete = 1 WHERE id = 1`
  ).run();
  await DB.prepare(
    `UPDATE branches SET business_email = 'owner@example.test', name = 'Test Biz',
     business_address = '123 Map Street\nLondon',
     logo_url = 'https://jin-jaw.co.uk/assets/jinjaw-square.png' WHERE id = 1`
  ).run();
});

describe('sendTestEmail', () => {
  it('uses the requested invoice sentence and attachment filename label', () => {
    expect(en.emailInvoiceBody('Jin&Jaw Ltd', '$14,270.00')).toBe(
      'Jin&Jaw Ltd has sent you an invoice for $14,270.00.'
    );
    expect(en.attachedBelow('JinJawLTD_Invoice_August_2026.pdf')).toBe(
      'JinJawLTD_Invoice_August_2026.pdf attached below'
    );
  });

  it('sends a sample invoice email with PDF to the business email', async () => {
    const sent: {
      to?: string;
      subject?: string;
      from?: { email: string; name: string };
      text?: string;
      html?: string;
      attachments?: { filename: string; content: Uint8Array }[];
    }[] = [];
    const EMAIL = {
      async send(msg: (typeof sent)[number]) {
        sent.push(msg);
      },
    } as unknown as SendEmail;

    const to = await sendTestEmail({ ...env, EMAIL }, DB, 1);
    expect(to).toBe('owner@example.test');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@example.test');
    expect(sent[0].subject).toBe('August 2026 Invoice from Test Biz');
    expect(sent[0].from?.email).toBe('contact@jin-jaw.co.uk');
    // The real PDF rides along (ASCII sample -> fast WinAnsi path -> compact file)
    expect(sent[0].attachments).toHaveLength(1);
    expect(sent[0].attachments![0].filename).toBe('JinJawLTD_Invoice_August_2026.pdf');
    expect(sent[0].attachments![0].content.length).toBeGreaterThan(1000);
    expect(sent[0].text).toContain('Test Biz has sent you an invoice for');
    expect(sent[0].text).not.toContain('A PDF copy is attached');
    expect(sent[0].html).toContain('JinJawLTD_Invoice_August_2026.pdf attached below');
    expect(sent[0].html).not.toContain('123 Map Street');
    expect(sent[0].html).toContain('src="https://jin-jaw.co.uk/assets/jinjaw-square.png"');
    expect(sent[0].html).toContain('object-fit: cover; border-radius: 8px;');
  });

  it('no database rows are created by the sample invoice', async () => {
    const EMAIL = { async send() {} } as unknown as SendEmail;
    const before = await DB.prepare('SELECT COUNT(*) AS n FROM invoices').first<{ n: number }>();
    await sendTestEmail({ ...env, EMAIL }, DB, 1);
    const after = await DB.prepare('SELECT COUNT(*) AS n FROM invoices').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('throws a descriptive error when no from-address is configured', async () => {
    await DB.prepare(`UPDATE settings SET email_from = '' WHERE id = 1`).run();
    await expect(sendTestEmail(env, DB, 1)).rejects.toThrow(/sending address/i);
  });

  it('throws when no business email is set to receive the test', async () => {
    await DB.prepare(`UPDATE branches SET business_email = NULL WHERE id = 1`).run();
    await expect(sendTestEmail(env, DB, 1)).rejects.toThrow(/business email/i);
  });
});

describe('email settings guard', () => {
  async function loginCookie(): Promise<string> {
    const r = await exports.default.fetch(
      new Request('https://invoice.test/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
        body: 'password=integration-test-password',
        redirect: 'manual',
      })
    );
    return r.headers.get('set-cookie')?.split(';')[0] ?? '';
  }

  it('refuses to switch to Resend when no key exists anywhere', async () => {
    await DB.prepare(`UPDATE settings SET email_provider = 'cloudflare', resend_api_key = '' WHERE id = 1`).run();
    const cookie = await loginCookie();
    const r = await exports.default.fetch(
      new Request('https://invoice.test/admin/settings/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          cookie,
        },
        body: 'email_provider=resend&email_from=b%40x.test&reminder_schedule=1',
        redirect: 'manual',
      })
    );
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('resend_kept=1');
    const row = await DB.prepare('SELECT email_provider FROM settings').first<{ email_provider: string }>();
    expect(row?.email_provider).toBe('cloudflare'); // previous provider kept
  });

  it('allows Resend when a key is submitted in the same save', async () => {
    await DB.prepare(`UPDATE settings SET email_provider = 'cloudflare', resend_api_key = '' WHERE id = 1`).run();
    const cookie = await loginCookie();
    const r = await exports.default.fetch(
      new Request('https://invoice.test/admin/settings/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          cookie,
        },
        body: 'email_provider=resend&email_from=b%40x.test&reminder_schedule=1&resend_api_key=re_live_abc123',
        redirect: 'manual',
      })
    );
    expect(r.headers.get('location')).not.toContain('resend_kept');
    const row = await DB.prepare('SELECT email_provider, resend_api_key FROM settings').first<{
      email_provider: string;
      resend_api_key: string;
    }>();
    expect(row?.email_provider).toBe('resend');
    expect(isBoxed(row?.resend_api_key ?? '')).toBe(true);
    expect(await unbox(TEST_MASTER_KEY, row?.resend_api_key ?? '')).toBe('re_live_abc123');
  });

  it('sends an invoice to the email stored on the client without exposing a copied recipient', async () => {
    const sent: { to?: string; cc?: string[]; subject?: string; from?: { email: string; name?: string }; text?: string; html?: string }[] = [];
    const EMAIL = {
      async send(message: (typeof sent)[number]) {
        sent.push(message);
      },
    } as unknown as SendEmail;
    const invoice: InvoiceWithClient = {
      id: 42,
      branch_id: 1,
      number: 'INV-0042',
      client_id: 7,
      client_name: 'Stored Client',
      client_email: 'accounts@client.test',
      client_address: '1 Client Way',
      client_locale: null,
      status: 'sent',
      currency: 'GBP',
      issue_date: '2026-08-29',
      due_date: null,
      subject: null,
      notes: 'Bank: Example Bank\nIBAN: GB00 TEST 0000 0000',
      tax_rate_bps: 0,
      subtotal_cents: 10000,
      tax_cents: 0,
      total_cents: 10000,
      public_token: 'stored-client-token',
      paypal_order_id: null,
      sent_at: null,
      paid_at: null,
      created_at: '2026-08-29 12:00:00',
      updated_at: '2026-08-29 12:00:00',
    };

    await sendInvoiceEmail({ ...env, EMAIL }, invoice, await getSettings(DB, 1), new Uint8Array([1, 2, 3]));

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('accounts@client.test');
    expect(sent[0].subject).toBe('August 2026 Invoice from Test Biz');
    expect(sent[0].cc).toBeUndefined();
    expect(sent[0].from?.email).toBe('contact@jin-jaw.co.uk');
    expect(sent[0].text).toContain('IBAN: GB00 TEST 0000 0000');
    expect(sent[0].html).toContain('IBAN: GB00 TEST 0000 0000');
    expect(sent[0].text).not.toContain('/pay/');
    expect(sent[0].html).not.toContain('/pay/');
  });

  it('sends the owner and client separate invoice messages, with the owner first', async () => {
    const sent: { to?: string; cc?: string[] }[] = [];
    const EMAIL = {
      async send(message: (typeof sent)[number]) {
        sent.push(message);
      },
    } as unknown as SendEmail;
    const invoice: InvoiceWithClient = {
      id: 43,
      branch_id: 1,
      number: 'INV-0043',
      client_id: 7,
      client_name: 'Stored Client',
      client_email: 'accounts@client.test',
      client_address: '1 Client Way',
      client_locale: null,
      status: 'draft',
      currency: 'GBP',
      issue_date: '2026-08-29',
      due_date: null,
      subject: null,
      notes: null,
      tax_rate_bps: 0,
      subtotal_cents: 10000,
      tax_cents: 0,
      total_cents: 10000,
      public_token: 'stored-client-token-2',
      paypal_order_id: null,
      sent_at: null,
      paid_at: null,
      created_at: '2026-08-29 12:00:00',
      updated_at: '2026-08-29 12:00:00',
    };

    const owner = await sendInvoiceEmailToClientAndOwner(
      { ...env, EMAIL },
      invoice,
      await getSettings(DB, 1),
      new Uint8Array([1, 2, 3])
    );

    expect(owner).toBe('owner@example.test');
    expect(sent.map((message) => message.to)).toEqual(['owner@example.test', 'accounts@client.test']);
    expect(sent.every((message) => message.cc === undefined)).toBe(true);
  });
});
