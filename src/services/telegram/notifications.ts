// Proactive Telegram messages: payment received and invoice overdue. Each
// (connection, event) pair is logged so a message is sent at most once.

import type { Bindings } from '../../env';
import { getInvoiceById, isOverdue, listBranches, listInvoices } from '../../db/queries';
import { formatCents } from '../../lib/money';
import { formatDateHuman, todayInTz } from '../../lib/dates';
import { telegramApi } from './api';
import type { TelegramConnection } from './repository';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function connections(db: D1Database, branchId: number): Promise<TelegramConnection[]> {
  return (
    await db
      .prepare('SELECT * FROM telegram_connections WHERE branch_id = ? AND personal_notifications = 1')
      .bind(branchId)
      .all<TelegramConnection>()
  ).results;
}

async function wasSent(db: D1Database, connectionId: number, eventKey: string): Promise<boolean> {
  return !!(await db
    .prepare('SELECT 1 AS found FROM telegram_notification_log WHERE connection_id = ? AND event_key = ?')
    .bind(connectionId, eventKey)
    .first());
}

async function markSent(db: D1Database, connectionId: number, eventKey: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO telegram_notification_log (connection_id, event_key) VALUES (?, ?)')
    .bind(connectionId, eventKey)
    .run();
}

export async function notifyInvoicePaid(env: Bindings, invoiceId: number): Promise<void> {
  const api = telegramApi(env);
  if (!api) return;
  const invoice = await getInvoiceById(env.DB, invoiceId);
  if (!invoice || invoice.status !== 'paid') return;
  const eventKey = `paid:${invoice.id}:${invoice.paid_at ?? invoice.updated_at}`;
  for (const connection of await connections(env.DB, invoice.branch_id)) {
    if (await wasSent(env.DB, connection.id, eventKey)) continue;
    try {
      await api.sendMessage(
        connection.telegram_chat_id,
        `💰 <b>Payment received</b>\n\n${esc(invoice.number)}\n${esc(invoice.client_name)}\n${esc(
          formatCents(invoice.total_cents, invoice.currency)
        )}`,
        [[{ text: 'View invoice', url: `${env.APP_BASE_URL}/admin/invoices/${invoice.id}` }]]
      );
      await markSent(env.DB, connection.id, eventKey);
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'telegram_paid_notification_failed', invoiceId, connectionId: connection.id, error: String(error) })
      );
    }
  }
}

/** Daily cron: one message per overdue invoice per due date. */
export async function notifyOverdueInvoices(env: Bindings): Promise<void> {
  const api = telegramApi(env);
  if (!api) return;
  for (const branch of await listBranches(env.DB)) {
    const settings = await env.DB.prepare('SELECT timezone FROM settings WHERE id = 1').first<{ timezone: string }>();
    const today = todayInTz(settings?.timezone ?? 'UTC');
    const invoices = (await listInvoices(env.DB, branch.id)).filter((invoice) => isOverdue(invoice, today));
    for (const invoice of invoices) {
      const days = Math.max(
        1,
        Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.due_date}T00:00:00Z`)) / 86_400_000)
      );
      const eventKey = `overdue:${invoice.id}:${invoice.due_date}`;
      for (const connection of await connections(env.DB, branch.id)) {
        if (await wasSent(env.DB, connection.id, eventKey)) continue;
        try {
          await api.sendMessage(
            connection.telegram_chat_id,
            `🔴 <b>Invoice overdue</b>\n\n${esc(invoice.number)}\n${esc(invoice.client_name)}\n${esc(
              formatCents(invoice.total_cents, invoice.currency)
            )}\n\nDue: ${formatDateHuman(invoice.due_date!)}\n${days} day${days === 1 ? '' : 's'} overdue`,
            [[{ text: 'View', callback_data: `inv:${invoice.id}` }, { text: 'Mark paid', callback_data: `paidask:${invoice.id}` }]]
          );
          await markSent(env.DB, connection.id, eventKey);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'telegram_overdue_notification_failed',
              invoiceId: invoice.id,
              connectionId: connection.id,
              error: String(error),
            })
          );
        }
      }
    }
  }
}
