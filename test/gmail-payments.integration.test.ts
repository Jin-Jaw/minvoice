import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/env';
import { createClient, createInvoice, markInvoiceSent } from '../src/db/queries';
import { box } from '../src/lib/secretbox';
import { scanGmailPayments } from '../src/services/gmail-payments';

const DB = env.DB;
const MESSAGE_ID = 'gmail-message-1';
// SETTINGS_MASTER_KEY from test/wrangler.test.jsonc, which seals the stored refresh token.
const TEST_MASTER_KEY = 'integration-test-master-key-0123456789abcdef';

const gmailEnv = (extra: Partial<Bindings> = {}) =>
  ({
    ...env,
    GMAIL_CLIENT_ID: 'google-client-id',
    GMAIL_CLIENT_SECRET: 'google-client-secret',
    ...extra,
  }) as Bindings;

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM gmail_payment_events'),
    DB.prepare('DELETE FROM payments'),
    DB.prepare('DELETE FROM invoice_events'),
    DB.prepare('DELETE FROM invoice_items'),
    DB.prepare('DELETE FROM invoices'),
    DB.prepare('DELETE FROM client_branches'),
    DB.prepare('DELETE FROM clients'),
    DB.prepare('DELETE FROM telegram_connections'),
    DB.prepare(
      `UPDATE settings SET gmail_enabled = 1, gmail_refresh_token = ?, gmail_address = 'books@example.test',
       gmail_query = 'from:payments@bank.example', gmail_last_checked_at = NULL WHERE id = 1`
    ).bind(await box(TEST_MASTER_KEY, 'refresh-token')),
  ]);
});

async function seedSentInvoice(): Promise<{ id: number; number: string; total: string }> {
  const clientId = await createClient(DB, {
    name: 'Acme',
    email: 'ap@acme.test',
    address: null,
    default_rate_cents: null,
    payment_terms_days: null,
  });
  const id = await createInvoice(DB, 1, {
    client_id: clientId,
    issue_date: '2026-09-01',
    due_date: '2026-09-15',
    subject: 'Retainer',
    notes: null,
    currency: 'GBP',
    items: [{ description: 'Work', quantity: 1, unit_price_cents: 123456 }],
  });
  await markInvoiceSent(DB, id);
  const row = await DB.prepare('SELECT number, total_cents FROM invoices WHERE id = ?')
    .bind(id)
    .first<{ number: string; total_cents: number }>();
  return { id, number: row!.number, total: (row!.total_cents / 100).toFixed(2) };
}

/** Google token + Gmail list/get endpoints serving one message; Telegram calls are recorded. */
function googleFetch(messageText: string, telegram: string[] = []): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      // The stored token is sealed; Google must receive the decrypted value.
      expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('refresh-token');
      return Response.json({ access_token: 'access-token' });
    }
    if (url.includes('/messages?')) return Response.json({ messages: [{ id: MESSAGE_ID }] });
    if (url.includes(`/messages/${MESSAGE_ID}`)) {
      return Response.json({
        id: MESSAGE_ID,
        internalDate: String(Date.UTC(2026, 8, 20)),
        snippet: messageText,
        payload: { headers: [{ name: 'From', value: 'payments@bank.example' }, { name: 'Subject', value: 'Payment received' }] },
      });
    }
    if (url.startsWith('https://api.telegram.org/')) {
      telegram.push(String(JSON.parse(String(init?.body)).text));
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe('scanGmailPayments', () => {
  it('marks one referenced sent invoice paid and deduplicates the Gmail message', async () => {
    const invoice = await seedSentInvoice();
    const fetchMock = googleFetch(`Payment for ${invoice.number} completed: GBP ${invoice.total}`);
    vi.stubGlobal('fetch', fetchMock);

    expect(await scanGmailPayments(gmailEnv())).toMatchObject({ checked: 1, paid: 1 });
    const row = await DB.prepare('SELECT status, paid_at FROM invoices WHERE id = ?')
      .bind(invoice.id)
      .first<{ status: string; paid_at: string }>();
    expect(row?.status).toBe('paid');
    expect(row?.paid_at).toBe('2026-09-20');
    expect(
      await DB.prepare(`SELECT COUNT(*) FROM payments WHERE provider_ref = 'gmail:${MESSAGE_ID}'`).first<number>('COUNT(*)')
    ).toBe(1);
    expect(
      (await DB.prepare('SELECT result FROM gmail_payment_events WHERE message_id = ?').bind(MESSAGE_ID).first<{ result: string }>())
        ?.result
    ).toBe('paid');
    expect(
      (await DB.prepare('SELECT gmail_last_checked_at FROM settings WHERE id = 1').first<{ gmail_last_checked_at: string | null }>())
        ?.gmail_last_checked_at
    ).not.toBeNull();

    fetchMock.mockClear();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access-token' });
      if (url.includes('/messages?')) return Response.json({ messages: [{ id: MESSAGE_ID }] });
      throw new Error(`Unexpected duplicate fetch: ${url}`);
    });
    expect(await scanGmailPayments(gmailEnv())).toMatchObject({ checked: 0, paid: 0, duplicate: 1 });
  });

  it('keeps an invoice open when the amount does not match', async () => {
    const invoice = await seedSentInvoice();
    vi.stubGlobal('fetch', googleFetch(`Payment for ${invoice.number} completed: GBP 1.00`));

    expect(await scanGmailPayments(gmailEnv())).toMatchObject({ checked: 1, paid: 0, ignored: 1 });
    expect(
      (await DB.prepare('SELECT status FROM invoices WHERE id = ?').bind(invoice.id).first<{ status: string }>())?.status
    ).toBe('sent');
    expect(await DB.prepare('SELECT COUNT(*) FROM payments').first<number>('COUNT(*)')).toBe(0);
  });

  it('tells the linked Telegram chat about an automatic match', async () => {
    const invoice = await seedSentInvoice();
    await DB.prepare(
      "INSERT INTO telegram_connections (branch_id, admin_subject, telegram_user_id, telegram_chat_id) VALUES (1, 'admin', '42', '42')"
    ).run();
    const telegram: string[] = [];
    vi.stubGlobal('fetch', googleFetch(`Payment for ${invoice.number} completed: GBP ${invoice.total}`, telegram));

    expect(
      await scanGmailPayments(
        gmailEnv({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret', TELEGRAM_BOT_USERNAME: 'bot' })
      )
    ).toMatchObject({ paid: 1 });
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain('Payment received');
    expect(telegram[0]).toContain(invoice.number);
  });

  it('does nothing, and calls nobody, while Gmail matching is off', async () => {
    await DB.prepare('UPDATE settings SET gmail_enabled = 0 WHERE id = 1').run();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await scanGmailPayments(gmailEnv())).toEqual({ checked: 0, paid: 0, review: 0, ignored: 0, duplicate: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
