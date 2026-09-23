import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, createInvoice, getInvoiceItems, getSettings, linkClientToBranch } from '../src/db/queries';
import { addDaysISO, todayInTz } from '../src/lib/dates';
import type { Bindings } from '../src/env';
import { handleTelegramUpdate } from '../src/services/telegram/handler';

const DB = env.DB;
const USER = 42;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

type Sent = { method: string; body: Record<string, any> };
let sent: Sent[] = [];
let updateId = 1000;
let aiAnswer: Record<string, unknown> = {};

const botEnv = () =>
  ({
    ...env,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    TELEGRAM_BOT_USERNAME: 'jinjaw_test_bot',
    AI: { run: async () => ({ response: aiAnswer }) },
  }) as unknown as Bindings;

const chat = { id: USER, type: 'private' as const };

async function text(value: string) {
  await handleTelegramUpdate(botEnv(), {
    update_id: ++updateId,
    message: { message_id: updateId, chat, from: { id: USER }, text: value },
  });
}

async function tap(data: string) {
  await handleTelegramUpdate(botEnv(), {
    update_id: ++updateId,
    callback_query: { id: `cb${updateId}`, from: { id: USER }, message: { message_id: 1, chat }, data },
  });
}

async function photo() {
  await handleTelegramUpdate(botEnv(), {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      chat,
      from: { id: USER },
      photo: [{ file_id: 'photo-1', file_unique_id: 'u1', width: 800, height: 1200, file_size: JPEG.length }],
    },
  });
}

const messages = () => sent.filter((m) => m.method === 'sendMessage').map((m) => String(m.body.text));
const lastMessage = () => messages().at(-1) ?? '';
const buttons = () =>
  (sent.filter((m) => m.method === 'sendMessage').at(-1)?.body.reply_markup?.inline_keyboard ?? []).flat() as {
    text: string;
    callback_data?: string;
  }[];

let clientId: number;
let previousInvoiceId: number;

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM telegram_sessions'),
    DB.prepare('DELETE FROM telegram_rate_limits'),
    DB.prepare('DELETE FROM telegram_processed_updates'),
    DB.prepare('DELETE FROM telegram_connections'),
    DB.prepare('DELETE FROM expense_attachments'),
    DB.prepare('DELETE FROM expenses'),
    DB.prepare('DELETE FROM expense_invoice_imports'),
    DB.prepare('DELETE FROM invoice_events'),
    DB.prepare('DELETE FROM invoice_items'),
    DB.prepare('DELETE FROM payments'),
    DB.prepare('DELETE FROM invoices'),
    DB.prepare('DELETE FROM client_branches'),
    DB.prepare('DELETE FROM clients'),
  ]);
  await DB.prepare(
    "INSERT INTO telegram_connections (branch_id, admin_subject, telegram_user_id, telegram_chat_id) VALUES (1, 'password-admin', ?, ?)"
  )
    .bind(String(USER), String(USER))
    .run();
  clientId = await createClient(
    DB,
    { name: 'ResVR Inc.', email: 'ap@resvr.test', address: null, default_rate_cents: null, payment_terms_days: null },
    1
  );
  await linkClientToBranch(DB, clientId, 1);
  previousInvoiceId = await createInvoice(DB, 1, {
    client_id: clientId,
    issue_date: '2026-08-01',
    due_date: null,
    subject: 'August retainer',
    notes: 'Pay to account 1234',
    currency: 'GBP',
    items: [
      { description: 'Retainer', quantity: 1, unit_price_cents: 250000 },
      { description: 'Extra support', quantity: 2, unit_price_cents: 40000 },
    ],
  });

  sent = [];
  aiAnswer = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/file/bot')) return new Response(JPEG);
    const method = url.split('/').pop()!;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    sent.push({ method, body });
    if (method === 'getFile') {
      return Response.json({ ok: true, result: { file_id: body.file_id, file_path: 'photos/receipt.jpg', file_size: JPEG.length } });
    }
    return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: 1, chat } : true });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(messages().filter((m) => m.startsWith('❌')), 'bot replied with an error').toEqual([]);
});

describe('Telegram /newinvoice', () => {
  it('builds an invoice from typed lines with currency, undo and due-date buttons', async () => {
    await text('/newinvoice');
    await tap(`client:${clientId}`);
    expect(buttons().map((b) => b.callback_data)).toContain(`repeat:${previousInvoiceId}`);
    await tap('cur:EUR');
    expect(lastMessage()).toContain('Currency set to <b>EUR</b>');
    await text('Shader work - 3 x 100');
    await text('Oops - 1');
    expect(lastMessage()).toContain('Subtotal: <b>€301.00</b>');
    await tap('undoline');
    expect(lastMessage()).toContain('Removed “Oops”');
    await tap('itemsdone');
    await tap('due:30');
    await tap('notesnone');
    expect(lastMessage()).toContain('Invoice draft');
    expect(lastMessage()).toContain('Payment details: None');
    await tap('create:1');

    const created = await DB.prepare('SELECT * FROM invoices WHERE id != ? ORDER BY id DESC LIMIT 1')
      .bind(previousInvoiceId)
      .first<{ id: number; currency: string; issue_date: string; due_date: string; notes: string | null }>();
    expect(created?.currency).toBe('EUR');
    expect(created?.due_date).toBe(addDaysISO(created!.issue_date, 30));
    expect(created?.notes).toBeNull();
    const items = await getInvoiceItems(DB, created!.id);
    expect(items.map((i) => [i.description, i.quantity, i.unit_price_cents])).toEqual([['Shader work', 3, 10000]]);
  });

  it('repeats the last invoice, then lets a line be removed from the summary', async () => {
    await text('/newinvoice');
    await tap(`client:${clientId}`);
    await tap(`repeat:${previousInvoiceId}`);
    expect(lastMessage()).toContain('copy of');
    expect(lastMessage()).toContain('Payment details: Pay to account 1234');
    await tap('rmmenu');
    await tap('rmline:2');
    await tap('create:1');

    const settings = await getSettings(DB, 1);
    const created = await DB.prepare('SELECT * FROM invoices WHERE id != ? ORDER BY id DESC LIMIT 1')
      .bind(previousInvoiceId)
      .first<{ id: number; currency: string; issue_date: string; subject: string; notes: string }>();
    expect(created?.issue_date).toBe(todayInTz(settings.timezone));
    expect(created?.subject).toBe('August retainer');
    expect(created?.notes).toBe('Pay to account 1234');
    const items = await getInvoiceItems(DB, created!.id);
    expect(items.map((i) => i.description)).toEqual(['Retainer']);
  });
});

describe('Telegram invoice extras', () => {
  it('creates a new client from /newinvoice and continues with it', async () => {
    await text('/newinvoice');
    await tap('newclient');
    await text('Acme Studio Ltd');
    await text('billing@acme.test');
    expect(messages().some((m) => m.includes('Client <b>Acme Studio Ltd</b> added'))).toBe(true);
    expect(lastMessage()).toContain('Client: <b>Acme Studio Ltd</b>');

    const client = await DB.prepare('SELECT * FROM clients WHERE name = ?')
      .bind('Acme Studio Ltd')
      .first<{ id: number; email: string; workspace_id: number }>();
    expect(client).toMatchObject({ email: 'billing@acme.test', workspace_id: 1 });
    const link = await DB.prepare('SELECT branch_id FROM client_branches WHERE client_id = ?').bind(client!.id).first();
    expect(link).toEqual({ branch_id: 1 });
  });

  it('backdates the invoice keeping the payment window, and overrides tax for one invoice', async () => {
    await text('/newinvoice');
    await tap(`client:${clientId}`);
    await text('Consulting - 1000');
    await tap('itemsdone');
    await tap('due:30');
    await tap('notesnone');
    await tap('editissue');
    const endOfMonth = buttons().find((b) => b.text.startsWith('End of last month'))!.callback_data!;
    await tap(endOfMonth);
    await tap('edittax');
    await tap('tax:0');
    expect(lastMessage()).toContain('Tax: none');
    await tap('create:1');

    const issueDate = endOfMonth.slice('issue:'.length);
    const created = await DB.prepare('SELECT * FROM invoices WHERE id != ? ORDER BY id DESC LIMIT 1')
      .bind(previousInvoiceId)
      .first<{ issue_date: string; due_date: string; tax_rate_bps: number; tax_cents: number; total_cents: number }>();
    expect(created).toMatchObject({
      issue_date: issueDate,
      due_date: addDaysISO(issueDate, 30),
      tax_rate_bps: 0,
      tax_cents: 0,
      total_cents: 100000,
    });
  });

  it('records a payment dated yesterday or on a typed date', async () => {
    const settings = await getSettings(DB, 1);
    const today = todayInTz(settings.timezone);
    await tap(`paidask:${previousInvoiceId}`);
    await tap(`paidy:${previousInvoiceId}`);
    expect(lastMessage()).toContain('marked paid on');
    const payment = await DB.prepare('SELECT created_at FROM payments WHERE invoice_id = ?')
      .bind(previousInvoiceId)
      .first<{ created_at: string }>();
    expect(payment?.created_at.slice(0, 10)).toBe(addDaysISO(today, -1));

    const second = await createInvoice(DB, 1, {
      client_id: clientId,
      issue_date: addDaysISO(today, -20),
      due_date: null,
      subject: null,
      notes: null,
      currency: 'GBP',
      items: [{ description: 'Work', quantity: 1, unit_price_cents: 5000 }],
    });
    await tap(`paiddate:${second}`);
    await text(addDaysISO(today, -5));
    const typed = await DB.prepare('SELECT created_at FROM payments WHERE invoice_id = ?')
      .bind(second)
      .first<{ created_at: string }>();
    expect(typed?.created_at.slice(0, 10)).toBe(addDaysISO(today, -5));
  });
});

describe('Telegram receipt photos', () => {
  it('reads the total, allows edits, and saves to the chosen company with the photo as evidence', async () => {
    aiAnswer = { total: 22.96, currency: 'GBP', tax: 3.83, supplier: 'Corner Hardware', date: '2026-09-18', category: 'Other' };
    await text('/uploadinvoice');
    await photo();
    expect(lastMessage()).toContain('Total: <b>£22.96</b>');
    expect(buttons().map((b) => b.text)).toContain('✅ Save £22.96');
    await tap('expedit:category');
    await tap('expcat:6');
    await tap('expedit:company');
    await tap('expcompany:2');
    expect(lastMessage()).toContain('Category: Equipment &amp; supplies');
    await tap('expenseconfirm:1');

    const expense = await DB.prepare('SELECT * FROM expenses ORDER BY id DESC LIMIT 1').first<{
      id: number;
      branch_id: number;
      payee: string;
      amount_cents: number;
      tax_cents: number;
      category: string;
      expense_date: string;
    }>();
    expect(expense).toMatchObject({
      branch_id: 2,
      payee: 'Corner Hardware',
      amount_cents: 2296,
      tax_cents: 383,
      category: 'Equipment & supplies',
      expense_date: '2026-09-18',
    });
    const evidence = await DB.prepare('SELECT mime FROM expense_attachments WHERE expense_id = ?')
      .bind(expense!.id)
      .first<{ mime: string }>();
    expect(evidence?.mime).toBe('image/jpeg');
  });

  it('asks for the amount and supplier when the photo cannot be read', async () => {
    aiAnswer = { total: null, supplier: null };
    await text('/uploadinvoice');
    await photo();
    expect(lastMessage()).toContain('couldn’t read the total');
    await text('£12.40');
    expect(lastMessage()).toContain('Who was paid?');
    await text('Corner Cafe');
    await tap('expedit:date');
    await tap('expday:1');
    await tap('expenseconfirm:1');

    const settings = await getSettings(DB, 1);
    const expense = await DB.prepare('SELECT * FROM expenses ORDER BY id DESC LIMIT 1').first<{
      branch_id: number;
      payee: string;
      amount_cents: number;
      currency: string;
      expense_date: string;
    }>();
    expect(expense).toMatchObject({
      branch_id: 1,
      payee: 'Corner Cafe',
      amount_cents: 1240,
      currency: settings.currency,
      expense_date: addDaysISO(todayInTz(settings.timezone), -1),
    });
  });
});
