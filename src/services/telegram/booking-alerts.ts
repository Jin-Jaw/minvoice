// Tells the admins on Telegram when a visitor books a call on jin-jaw.co.uk.
// The website Worker reaches this through a service binding (BookingAlerts in
// index.tsx), so there is no public URL for it.

import type { Bindings } from '../../env';
import { telegramApi } from './api';

export type CallBooking = {
  /** The booking id from the website; one alert per id and chat. */
  id: string;
  /** Start and end as ISO 8601 instants. */
  start: string;
  end: string;
  name: string;
  email: string;
  company?: string;
  meetUrl?: string;
};

const ZONE = 'Europe/London';
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'long', day: 'numeric', month: 'long' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A short single-line string, or '' when the value is missing or not text. */
function line(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Returns how many chats received the alert. */
export async function notifyCallBooked(env: Bindings, input: CallBooking): Promise<number> {
  const api = telegramApi(env);
  if (!api) return 0;
  const id = line(input?.id, 64);
  const start = new Date(line(input?.start, 40));
  const end = new Date(line(input?.end, 40));
  const name = line(input?.name, 80);
  if (!id || !name || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const email = line(input.email, 254);
  const company = line(input.company, 80);
  const meetUrl = line(input.meetUrl, 300);

  const text = [
    '📞 <b>Call booked</b>',
    '',
    esc(company ? `${name}, ${company}` : name),
    ...(email ? [esc(email)] : []),
    '',
    `${dayFormat.format(start)}, ${timeFormat.format(start)} to ${timeFormat.format(end)} London time`,
  ].join('\n');
  const keyboard = /^https:\/\/meet\.google\.com\//.test(meetUrl) ? [[{ text: 'Open Google Meet', url: meetUrl }]] : undefined;

  const chats = (
    await env.DB.prepare('SELECT id, telegram_chat_id FROM telegram_connections WHERE personal_notifications = 1').all<{
      id: number;
      telegram_chat_id: string;
    }>()
  ).results;
  const eventKey = `call:${id}`;
  let delivered = 0;
  for (const chat of chats) {
    const logged = await env.DB.prepare('INSERT OR IGNORE INTO telegram_notification_log (connection_id, event_key) VALUES (?, ?)')
      .bind(chat.id, eventKey)
      .run();
    if (!logged.meta.changes) continue;
    try {
      await api.sendMessage(chat.telegram_chat_id, text, keyboard);
      delivered++;
    } catch (error) {
      await env.DB.prepare('DELETE FROM telegram_notification_log WHERE connection_id = ? AND event_key = ?').bind(chat.id, eventKey).run();
      console.error(JSON.stringify({ event: 'telegram_call_booked_alert_failed', connectionId: chat.id, error: String(error) }));
    }
  }
  return delivered;
}
