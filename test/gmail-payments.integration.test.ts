import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/env';
import { scanGmailPayments } from '../src/services/gmail-payments';

const DB = env.DB;

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM gmail_payment_events'),
    DB.prepare('DELETE FROM payments'),
    DB.prepare('DELETE FROM invoice_events'),
    DB.prepare('DELETE FROM invoice_items'),
    DB.prepare('DELETE FROM invoices'),
    DB.prepare('DELETE FROM clients'),
    DB.prepare(
      `UPDATE settings SET gmail_enabled = 1, gmail_refresh_token = 'refresh-token', gmail_address = 'books@example.test',
       gmail_query = 'from:payments@bank.example newer_than:30d', gmail_last_checked_at = NULL WHERE id = 1`
    ),
  ]);
});

async function seedSentInvoice(): Promise<number> {
  const client = await DB.prepare("INSERT INTO clients (name) VALUES ('Acme')").run();
  const invoice = await DB.prepare(
    `INSERT INTO invoices
      (branch_id, number, client_id, status, currency, issue_date, total_cents, public_token, sent_at)
     VALUES (1, 'INV-0042', ?, 'sent', 'GBP', '2026-09-01', 123456, 'gmail-test-token', datetime('now'))`
  ).bind(client.meta.last_row_id).run();
  return invoice.meta.last_row_id;
}

function googleFetch(messageText: string): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access-token' });
    if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'gmail-message-1' }] });
    if (url.includes('/messages/gmail-message-1')) {
      return Response.json({
        id: 'gmail-message-1',
        internalDate: String(Date.UTC(2026, 8, 5)),
        snippet: messageText,
        payload: { headers: [{ name: 'From', value: 'payments@bank.example' }, { name: 'Subject', value: 'Payment received' }] },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe('scanGmailPayments', () => {
  it('marks one exact sent-invoice match paid and deduplicates the Gmail message', async () => {
    const invoiceId = await seedSentInvoice();
    const fetchMock = googleFetch('Payment for INV-0042 completed: GBP 1,234.56');
    vi.stubGlobal('fetch', fetchMock);
    const bindings = {
      ...env,
      GMAIL_CLIENT_ID: 'google-client-id',
      GMAIL_CLIENT_SECRET: 'google-client-secret',
    } as Bindings;

    expect(await scanGmailPayments(bindings)).toMatchObject({ checked: 1, paid: 1 });
    expect((await DB.prepare('SELECT status FROM invoices WHERE id = ?').bind(invoiceId).first<{ status: string }>())?.status).toBe('paid');
    expect(await DB.prepare("SELECT COUNT(*) FROM payments WHERE provider_ref = 'gmail:gmail-message-1'").first<number>('COUNT(*)')).toBe(1);
    expect((await DB.prepare("SELECT result FROM gmail_payment_events WHERE message_id = 'gmail-message-1'").first<{ result: string }>())?.result).toBe('paid');

    fetchMock.mockClear();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access-token' });
      if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'gmail-message-1' }] });
      throw new Error(`Unexpected duplicate fetch: ${url}`);
    });
    expect(await scanGmailPayments(bindings)).toMatchObject({ checked: 0, paid: 0, duplicate: 1 });
  });

  it('keeps an invoice open when the amount does not match', async () => {
    const invoiceId = await seedSentInvoice();
    vi.stubGlobal('fetch', googleFetch('Payment for INV-0042 completed: GBP 1,200.00'));
    const bindings = {
      ...env,
      GMAIL_CLIENT_ID: 'google-client-id',
      GMAIL_CLIENT_SECRET: 'google-client-secret',
    } as Bindings;

    expect(await scanGmailPayments(bindings)).toMatchObject({ checked: 1, paid: 0, ignored: 1 });
    expect((await DB.prepare('SELECT status FROM invoices WHERE id = ?').bind(invoiceId).first<{ status: string }>())?.status).toBe('sent');
    expect(await DB.prepare('SELECT COUNT(*) FROM payments').first<number>('COUNT(*)')).toBe(0);
  });
});
