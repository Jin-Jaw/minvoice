import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/env';
import { notifyCallBooked, type CallBooking } from '../src/services/telegram/booking-alerts';

const DB = env.DB;
type Sent = { chat_id: string; text: string; reply_markup?: { inline_keyboard: { text: string; url?: string }[][] } };
let sent: Sent[] = [];
let refuse = false;

const botEnv = () => ({ ...env, TELEGRAM_BOT_TOKEN: 'test-token' }) as unknown as Bindings;
const booking = (extra: Partial<CallBooking> = {}): CallBooking => ({
  id: 'b1f0c2de-0000-4000-8000-000000000001',
  // 10:00 UTC in November is 10:00 in London.
  start: '2026-11-18T10:00:00.000Z',
  end: '2026-11-18T10:30:00.000Z',
  name: 'Sam <Rivera>',
  email: 'sam@studio.test',
  company: 'Northlight & Co',
  meetUrl: 'https://meet.google.com/abc-defg-hij',
  ...extra,
});

beforeEach(async () => {
  await DB.prepare('DELETE FROM telegram_connections').run();
  await DB.prepare(
    "INSERT INTO telegram_connections (branch_id, admin_subject, telegram_user_id, telegram_chat_id) VALUES (1, 'password-admin', '42', '42')"
  ).run();
  sent = [];
  refuse = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (refuse) return Response.json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, { status: 403 });
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
});

afterEach(() => vi.restoreAllMocks());

describe('Call booking alerts', () => {
  it('sends the visitor, the London time and the Meet link to each connected admin', async () => {
    expect(await notifyCallBooked(botEnv(), booking())).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe('42');
    expect(sent[0].text).toContain('Call booked');
    expect(sent[0].text).toContain('Sam &lt;Rivera&gt;, Northlight &amp; Co');
    expect(sent[0].text).toContain('sam@studio.test');
    expect(sent[0].text).toContain('Wednesday 18 November, 10:00 to 10:30 London time');
    expect(sent[0].reply_markup?.inline_keyboard[0][0].url).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('sends one alert per booking, even when the website calls twice', async () => {
    await notifyCallBooked(botEnv(), booking());
    expect(await notifyCallBooked(botEnv(), booking())).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('skips admins who turned notifications off and bookings without a name or time', async () => {
    expect(await notifyCallBooked(botEnv(), booking({ id: 'no-name', name: ' ' }))).toBe(0);
    expect(await notifyCallBooked(botEnv(), booking({ id: 'no-time', start: 'soon' }))).toBe(0);
    await DB.prepare('UPDATE telegram_connections SET personal_notifications = 0').run();
    expect(await notifyCallBooked(botEnv(), booking())).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('leaves out a link that is not Google Meet, and retries after Telegram refuses', async () => {
    refuse = true;
    expect(await notifyCallBooked(botEnv(), booking({ meetUrl: 'https://example.com/call' }))).toBe(0);
    refuse = false;
    expect(await notifyCallBooked(botEnv(), booking({ meetUrl: 'https://example.com/call' }))).toBe(1);
    expect(sent[0].reply_markup).toBeUndefined();
  });

  it('does nothing when the bot is not configured', async () => {
    expect(await notifyCallBooked({ ...env } as unknown as Bindings, booking())).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
