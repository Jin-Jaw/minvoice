import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBranch, createClient, linkClientToBranch } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { handleTelegramUpdate } from '../src/services/telegram/handler';
import { handleSubmissionsUpdate } from '../src/services/submissions/handler';
import { purgeSubmissionsData } from '../src/services/submissions/repository';

const DB = env.DB;
const ADMIN = 42;
const STAFF = 77;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

type Sent = { bot: 'admin' | 'staff'; method: string; body: Record<string, any> };
let sent: Sent[] = [];
let updateId = 5000;
let aiAnswer: Record<string, unknown> = {};
let arabiaBranch: number;

const botEnv = () =>
  ({
    ...env,
    TELEGRAM_BOT_TOKEN: 'admin-token',
    TELEGRAM_WEBHOOK_SECRET: 'admin-secret',
    TELEGRAM_BOT_USERNAME: 'jinjaw_test_bot',
    SUBMISSIONS_BOT_TOKEN: 'staff-token',
    SUBMISSIONS_WEBHOOK_SECRET: 'staff-secret',
    AI: { run: async () => ({ response: aiAnswer }) },
  }) as unknown as Bindings;

const chat = (id: number) => ({ id, type: 'private' as const });
const staffUser = { id: STAFF, username: 'sara', first_name: 'Sara', last_name: 'Haddad' };

async function staffText(value: string) {
  await handleSubmissionsUpdate(botEnv(), {
    update_id: ++updateId,
    message: { message_id: updateId, chat: chat(STAFF), from: staffUser, text: value },
  });
}

async function staffTap(data: string) {
  await handleSubmissionsUpdate(botEnv(), {
    update_id: ++updateId,
    callback_query: { id: `cb${updateId}`, from: staffUser, message: { message_id: 1, chat: chat(STAFF) }, data },
  });
}

async function staffPhoto() {
  await handleSubmissionsUpdate(botEnv(), {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      chat: chat(STAFF),
      from: staffUser,
      photo: [{ file_id: 'photo-1', file_unique_id: 'u1', width: 800, height: 1200, file_size: JPEG.length }],
    },
  });
}

async function adminText(value: string) {
  await handleTelegramUpdate(botEnv(), {
    update_id: ++updateId,
    message: { message_id: updateId, chat: chat(ADMIN), from: { id: ADMIN }, text: value },
  });
}

async function adminTap(data: string, messageId = 900) {
  await handleTelegramUpdate(botEnv(), {
    update_id: ++updateId,
    callback_query: { id: `cb${updateId}`, from: { id: ADMIN }, message: { message_id: messageId, chat: chat(ADMIN) }, data },
  });
}

const textOf = (message: Sent) => String(message.body.text ?? message.body.caption ?? '');
const withText = (bot: Sent['bot']) =>
  sent.filter((m) => m.bot === bot && ['sendMessage', 'sendPhoto', 'sendDocument'].includes(m.method));
const last = (bot: Sent['bot']) => withText(bot).at(-1);
const lastText = (bot: Sent['bot']) => {
  const message = last(bot);
  return message ? textOf(message) : '';
};
const buttonsOf = (message: Sent | undefined) =>
  ((message?.body.reply_markup?.inline_keyboard ?? []) as { text: string; callback_data?: string; url?: string }[][]).flat();

async function allowStaff() {
  await staffText('/start');
  const request = last('admin');
  const allow = buttonsOf(request).find((b) => b.callback_data?.startsWith('suballow:'))!;
  await adminTap(allow.callback_data!);
}

beforeEach(async () => {
  const workspace = await DB.prepare(
    "INSERT INTO workspaces (name, slug) VALUES ('Jin&Jaw Arabia', 'jinjaw-arabia') RETURNING id"
  ).first<{ id: number }>();
  arabiaBranch = await createBranch(DB, workspace!.id, {
    name: 'Jin&Jaw Arabia S.A.R.L',
    business_address: 'Beirut',
    business_email: null,
    currency: 'USD',
    invoice_prefix: 'JJA-',
  });
  await DB.prepare(
    "INSERT INTO telegram_connections (branch_id, admin_subject, telegram_user_id, telegram_chat_id) VALUES (1, 'jad@test', ?, ?)"
  )
    .bind(String(ADMIN), String(ADMIN))
    .run();

  sent = [];
  aiAnswer = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/file/bot')) return new Response(JPEG);
    const bot = url.includes('staff-token') ? 'staff' : 'admin';
    const method = url.split('/').pop()!;
    let body: Record<string, any> = {};
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    else if (init?.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) {
        body[key] = key === 'reply_markup' ? JSON.parse(String(value)) : typeof value === 'string' ? value : `file:${value.name}`;
      }
    }
    sent.push({ bot, method, body });
    if (method === 'getFile') {
      return Response.json({ ok: true, result: { file_id: body.file_id, file_path: 'photos/receipt.jpg', file_size: JPEG.length } });
    }
    return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: 1, chat: chat(0) } : true });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Rejections also start with ❌; every other ❌ reply is an error.
  const errors = withText('admin')
    .concat(withText('staff'))
    .map(textOf)
    .filter((text) => text.startsWith('❌ ') && !/Rejected request|was not approved/.test(text));
  await DB.batch([
    DB.prepare('DELETE FROM expense_attachments'),
    DB.prepare('DELETE FROM income_attachments'),
    DB.prepare('DELETE FROM submissions'),
    DB.prepare('DELETE FROM expenses'),
    DB.prepare('DELETE FROM income_entries'),
    DB.prepare('DELETE FROM telegram_submitters'),
    DB.prepare('DELETE FROM submissions_bot_updates'),
    DB.prepare('DELETE FROM telegram_sessions'),
    DB.prepare('DELETE FROM telegram_rate_limits'),
    DB.prepare('DELETE FROM telegram_processed_updates'),
    DB.prepare('DELETE FROM telegram_connections'),
    DB.prepare('DELETE FROM client_branches'),
    DB.prepare('DELETE FROM clients'),
    DB.prepare("DELETE FROM branches WHERE name LIKE 'Jin&Jaw Arabia%'"),
    DB.prepare("DELETE FROM workspaces WHERE slug = 'jinjaw-arabia'"),
  ]);
  expect(errors, 'a bot replied with an error').toEqual([]);
});

describe('staff bot access', () => {
  it('asks the admin before a new person can send anything', async () => {
    await staffText('/start');
    expect(lastText('staff')).toContain('I’ve asked the admin to give you access');
    expect(lastText('admin')).toContain('Sara Haddad (@sara) wants to send expenses and income');

    await staffText('/expense');
    expect(lastText('staff')).toContain('still waiting for the admin');
    expect(await DB.prepare('SELECT COUNT(*) AS n FROM submissions').first('n')).toBe(0);

    const allow = buttonsOf(last('admin')).find((b) => b.callback_data?.startsWith('suballow:'))!;
    await adminTap(allow.callback_data!);
    expect(lastText('admin')).toContain('can now send expense and income requests');
    expect(lastText('staff')).toContain('The admin gave you access');
    expect(await DB.prepare('SELECT status FROM telegram_submitters').first('status')).toBe('active');
  });

  it('keeps a denied person out', async () => {
    await staffText('/start');
    const deny = buttonsOf(last('admin')).find((b) => b.callback_data?.startsWith('subdeny:'))!;
    await adminTap(deny.callback_data!);
    expect(lastText('staff')).toContain('declined your access request');
    await staffText('Taxi 25');
    expect(lastText('staff')).toContain('You don’t have access to this bot');
    expect(await DB.prepare('SELECT COUNT(*) AS n FROM submissions').first('n')).toBe(0);
  });
});

describe('staff expense requests', () => {
  it('reads a receipt photo, waits for approval, then saves the expense with the photo', async () => {
    await allowStaff();
    aiAnswer = { total: 22.96, currency: 'USD', tax: 3.83, supplier: 'Corner Hardware', date: '2026-09-18', category: 'Other' };
    await staffTap('expense');
    await staffPhoto();
    expect(lastText('staff')).toContain('Paid to: Corner Hardware');
    expect(lastText('staff')).toContain('Amount: <b>$22.96</b>');
    await staffTap('edit:note');
    await staffText('Shelves for the office');
    await staffTap('submit');
    expect(lastText('staff')).toContain('Sent for approval as request');
    expect(await DB.prepare('SELECT COUNT(*) AS n FROM expenses').first('n')).toBe(0);

    const card = last('admin')!;
    expect(card.method).toBe('sendPhoto');
    expect(textOf(card)).toContain('Expense request #');
    expect(textOf(card)).toContain('From: Sara Haddad (@sara)');
    expect(textOf(card)).toContain('Note: Shelves for the office');
    const approve = buttonsOf(card).find((b) => b.callback_data?.startsWith('subok:'))!;
    await adminTap(approve.callback_data!, 321);

    expect(sent.some((m) => m.bot === 'admin' && m.method === 'editMessageReplyMarkup' && m.body.message_id === 321)).toBe(true);
    const expense = await DB.prepare('SELECT * FROM expenses').first<Record<string, unknown>>();
    expect(expense).toMatchObject({
      branch_id: arabiaBranch,
      payee: 'Corner Hardware',
      amount_cents: 2296,
      tax_cents: 383,
      currency: 'USD',
      expense_date: '2026-09-18',
    });
    expect(String(expense!.description)).toContain('Staff bot request #');
    expect(String(expense!.description)).toContain('Shelves for the office');
    const evidence = await DB.prepare('SELECT mime FROM expense_attachments WHERE expense_id = ?').bind(expense!.id).first('mime');
    expect(evidence).toBe('image/jpeg');
    const submission = await DB.prepare('SELECT status, expense_id, file_bytes, decided_by FROM submissions').first();
    expect(submission).toMatchObject({ status: 'approved', expense_id: expense!.id, file_bytes: null, decided_by: 'jad@test' });
    expect(lastText('staff')).toContain('was approved: Corner Hardware, $22.96');
    expect(buttonsOf(last('admin')).find((b) => b.url)?.url).toContain(`/admin/expenses/${expense!.id}?workspace=`);

    // A second tap on the same card changes nothing.
    await adminTap(approve.callback_data!, 321);
    expect(lastText('admin')).toContain('has already been decided');
    expect(await DB.prepare('SELECT COUNT(*) AS n FROM expenses').first('n')).toBe(1);
  });

  it('accepts a typed expense and asks for what is missing', async () => {
    await allowStaff();
    await staffTap('expense');
    await staffText('45');
    expect(lastText('staff')).toContain('Who was paid?');
    await staffText('Airport Taxi Co');
    expect(lastText('staff')).toContain('Invoice: None attached');
    await staffTap('edit:category');
    await staffTap('cat:3');
    expect(lastText('staff')).toContain('Category: Travel &amp; accommodation');
    await staffTap('submit');

    const card = last('admin')!;
    expect(card.method).toBe('sendMessage');
    await adminTap(buttonsOf(card).find((b) => b.callback_data?.startsWith('subok:'))!.callback_data!);
    const expense = await DB.prepare('SELECT payee, amount_cents, currency, category FROM expenses').first();
    expect(expense).toEqual({ payee: 'Airport Taxi Co', amount_cents: 4500, currency: 'USD', category: 'Travel & accommodation' });
    expect(await DB.prepare('SELECT COUNT(*) AS n FROM expense_attachments').first('n')).toBe(0);
  });
});

describe('staff income requests', () => {
  it('rejects a typed income with a reason and records nothing', async () => {
    await allowStaff();
    await staffText('Acme Studio 1200');
    expect(lastText('staff')).toContain('Is this an expense or income?');
    await staffTap('kind:income');
    expect(lastText('staff')).toContain('Received from: Acme Studio');
    expect(lastText('staff')).toContain('Amount: <b>$1,200.00</b>');
    await staffTap('submit');

    const card = last('admin')!;
    expect(textOf(card)).toContain('Income request #');
    await adminTap(buttonsOf(card).find((b) => b.callback_data?.startsWith('subno:'))!.callback_data!, 555);
    expect(lastText('admin')).toContain('Why are you rejecting request');
    await adminText('Wrong month, please resend');

    expect(await DB.prepare('SELECT status, decision_note FROM submissions').first()).toEqual({
      status: 'rejected',
      decision_note: 'Wrong month, please resend',
    });
    expect(await DB.prepare('SELECT COUNT(*) AS n FROM income_entries').first('n')).toBe(0);
    expect(sent.some((m) => m.method === 'editMessageReplyMarkup' && m.body.message_id === 555)).toBe(true);
    expect(lastText('staff')).toContain('was not approved');
    expect(lastText('staff')).toContain('Reason: Wrong month, please resend');
  });

  it('approves an income photo, links the client by name and keeps the invoice', async () => {
    const clientId = await createClient(
      DB,
      { name: 'Acme Studio', email: null, address: null, default_rate_cents: null, payment_terms_days: null },
      1
    );
    await linkClientToBranch(DB, clientId, arabiaBranch);
    await allowStaff();
    // The reader names the issuer as the supplier; income never uses it.
    aiAnswer = { total: 800, currency: 'USD', supplier: 'Jin&Jaw Arabia S.A.R.L', date: '2026-09-10', reference: 'JJA-7' };
    await staffPhoto();
    expect(lastText('staff')).toContain('Is this an expense or income?');
    await staffTap('kind:income');
    expect(lastText('staff')).toContain('Who paid?');
    await staffText('acme studio');
    await staffTap('submit');
    await adminTap(buttonsOf(last('admin')).find((b) => b.callback_data?.startsWith('subok:'))!.callback_data!);

    const income = await DB.prepare('SELECT * FROM income_entries').first<Record<string, unknown>>();
    expect(income).toMatchObject({
      branch_id: arabiaBranch,
      client_id: clientId,
      payer: 'acme studio',
      amount_cents: 80000,
      currency: 'USD',
      income_date: '2026-09-10',
    });
    expect(String(income!.reference)).toContain('JJA-7');
    const evidence = await DB.prepare('SELECT mime FROM income_attachments WHERE income_id = ?').bind(income!.id).first('mime');
    expect(evidence).toBe('image/jpeg');
  });
});

describe('admin bot lists', () => {
  it('lists pending requests and shows one again with its buttons', async () => {
    await allowStaff();
    await staffText('Printer paper 12');
    await staffTap('kind:expense');
    await staffTap('submit');
    await adminText('/pending');
    expect(lastText('admin')).toContain('waiting for approval');
    const view = buttonsOf(last('admin')).find((b) => b.callback_data?.startsWith('subview:'))!;
    await adminTap(view.callback_data!);
    expect(buttonsOf(last('admin')).map((b) => b.callback_data)).toContain(view.callback_data!.replace('subview', 'subok'));

    await adminText('/submitters');
    expect(lastText('admin')).toContain('Sara Haddad (@sara): can send requests');
    await adminTap(buttonsOf(last('admin')).find((b) => b.callback_data?.startsWith('subrevoke:'))!.callback_data!);
    expect(await DB.prepare('SELECT status FROM telegram_submitters').first('status')).toBe('revoked');
  });
});

describe('staff bot housekeeping and webhook', () => {
  it('purges abandoned drafts but keeps sent requests', async () => {
    await allowStaff();
    await staffText('Printer paper 12');
    await staffTap('kind:expense');
    await staffTap('submit');
    await staffText('Coffee 4');
    await DB.prepare("UPDATE submissions SET updated_at = datetime('now', '-2 days')").run();
    await purgeSubmissionsData(DB);
    const rows = await DB.prepare('SELECT status FROM submissions').all<{ status: string }>();
    expect(rows.results.map((row) => row.status)).toEqual(['pending']);
  });

  it('rejects deliveries without the staff bot secret', async () => {
    const post = (secret?: string) =>
      exports.default.fetch(
        new Request('https://invoice.test/api/integrations/telegram/submissions/webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) },
          body: JSON.stringify({ update_id: 1 }),
        })
      );
    // The test Worker has no staff bot secrets, so the route reports it is not set up.
    expect((await post('anything')).status).toBe(503);
  });
});
