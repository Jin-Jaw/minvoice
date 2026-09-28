// D1 access for the Telegram bot: account linking, conversation sessions,
// update de-duplication, rate limiting, and invoice attachments.

import type { Branch } from '../../db/queries';
import type { EmailAttachment } from '../email';

export type TelegramConnection = {
  id: number;
  branch_id: number;
  admin_subject: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  telegram_username: string | null;
  personal_notifications: number;
  created_at: string;
  last_used_at: string | null;
};

export type TelegramSession = {
  telegram_user_id: string;
  branch_id: number;
  flow: string;
  step: string;
  data_json: string;
  expires_at: string;
  updated_at: string;
};

export type InvoiceAttachmentMeta = {
  id: number;
  invoice_id: number;
  mime: string;
  filename: string;
  size_bytes: number;
};

export type InvoiceAttachment = InvoiceAttachmentMeta & { bytes: Uint8Array };

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// ---------- Linking ----------

/** One-time /start token; only its hash is stored. Expires after 10 minutes. */
export async function createLinkToken(db: D1Database, branchId: number, adminSubject: string): Promise<string> {
  const token = randomToken();
  const hash = await sha256Hex(token);
  await db.batch([
    db.prepare('DELETE FROM telegram_link_tokens WHERE branch_id = ? AND admin_subject = ?').bind(branchId, adminSubject),
    db
      .prepare(
        "INSERT INTO telegram_link_tokens (token_hash, branch_id, admin_subject, expires_at) VALUES (?, ?, ?, datetime('now', '+10 minutes'))"
      )
      .bind(hash, branchId, adminSubject),
  ]);
  return token;
}

export async function consumeLinkToken(
  db: D1Database,
  token: string,
  userId: string,
  chatId: string,
  username: string | undefined
): Promise<TelegramConnection | null> {
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(
      "DELETE FROM telegram_link_tokens WHERE token_hash = ? AND expires_at > datetime('now') RETURNING token_hash, branch_id, admin_subject"
    )
    .bind(hash)
    .first<{ token_hash: string; branch_id: number; admin_subject: string }>();
  if (!row) return null;
  await db.batch([
    db
      .prepare('DELETE FROM telegram_connections WHERE telegram_user_id = ? OR (branch_id = ? AND admin_subject = ?)')
      .bind(userId, row.branch_id, row.admin_subject),
    db
      .prepare(
        `INSERT INTO telegram_connections
       (branch_id, admin_subject, telegram_user_id, telegram_chat_id, telegram_username)
       VALUES (?, ?, ?, ?, ?)`
      )
      .bind(row.branch_id, row.admin_subject, userId, chatId, username ?? null),
  ]);
  return getConnection(db, userId);
}

export function getConnection(db: D1Database, userId: string): Promise<TelegramConnection | null> {
  return db
    .prepare('SELECT * FROM telegram_connections WHERE telegram_user_id = ?')
    .bind(userId)
    .first<TelegramConnection>();
}

export async function touchConnection(
  db: D1Database,
  userId: string,
  chatId: string,
  username: string | undefined
): Promise<void> {
  await db
    .prepare(
      "UPDATE telegram_connections SET telegram_chat_id = ?, telegram_username = ?, last_used_at = datetime('now') WHERE telegram_user_id = ?"
    )
    .bind(chatId, username ?? null, userId)
    .run();
}

export function getConnectionForAdmin(db: D1Database, adminSubject: string): Promise<TelegramConnection | null> {
  return db
    .prepare('SELECT * FROM telegram_connections WHERE admin_subject = ? ORDER BY last_used_at DESC LIMIT 1')
    .bind(adminSubject)
    .first<TelegramConnection>();
}

export async function disconnectAdmin(db: D1Database, adminSubject: string): Promise<void> {
  await db.prepare('DELETE FROM telegram_connections WHERE admin_subject = ?').bind(adminSubject).run();
}

/** Switch the bot's active company; false when that company is inactive or missing. */
export async function setConnectionBranch(db: D1Database, userId: string, branchId: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE telegram_connections SET branch_id = ?, last_used_at = datetime('now')
     WHERE telegram_user_id = ? AND EXISTS (SELECT 1 FROM branches WHERE id = ? AND active = 1)`
    )
    .bind(branchId, userId, branchId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

// ---------- Delivery guards ----------

/** Telegram retries deliveries; each update_id is processed at most once. */
export async function claimUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO telegram_processed_updates (update_id) VALUES (?)')
    .bind(updateId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

const RATE_LIMIT_PER_MINUTE = 30;

/** Counts one update against a user's per-minute window (`key` is the user id, prefixed per bot). */
export function rateLimitStatement(db: D1Database, key: string): D1PreparedStatement {
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  return db
    .prepare(
      `INSERT INTO telegram_rate_limits (telegram_user_id, window_start, request_count) VALUES (?, ?, 1)
     ON CONFLICT (telegram_user_id, window_start) DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`
    )
    .bind(key, windowStart);
}

export function withinRateLimit(result: D1Result): boolean {
  return ((result.results[0] as { request_count: number } | undefined)?.request_count ?? 100) <= RATE_LIMIT_PER_MINUTE;
}

/** 30 updates per user per minute. */
export async function consumeRateLimit(db: D1Database, userId: string): Promise<boolean> {
  return withinRateLimit(await rateLimitStatement(db, userId).run());
}

export type UpdateStart = {
  /** False when this update id was already handled (Telegram re-delivered it). */
  claimed: boolean;
  withinLimit: boolean;
  connection: TelegramConnection | null;
  /** The connection's active company, or null when it is inactive or missing. */
  branch: Branch | null;
  session: TelegramSession | null;
};

/**
 * Everything the admin bot reads before it handles an update, in one D1
 * round trip: claim the update id, count it against the rate limit, refresh
 * the connection's chat details, and load the connection, its company and
 * the open conversation. Every reply waits on this, so it stays one batch.
 */
export async function beginUpdate(
  db: D1Database,
  updateId: number,
  userId: string,
  chatId: string,
  username: string | undefined
): Promise<UpdateStart> {
  const [claim, rate, , connection, branch, session] = await db.batch([
    db.prepare('INSERT OR IGNORE INTO telegram_processed_updates (update_id) VALUES (?)').bind(updateId),
    rateLimitStatement(db, userId),
    db
      .prepare(
        "UPDATE telegram_connections SET telegram_chat_id = ?, telegram_username = ?, last_used_at = datetime('now') WHERE telegram_user_id = ?"
      )
      .bind(chatId, username ?? null, userId),
    db.prepare('SELECT * FROM telegram_connections WHERE telegram_user_id = ?').bind(userId),
    db
      .prepare(
        `SELECT b.* FROM branches b JOIN telegram_connections c ON c.branch_id = b.id
       WHERE c.telegram_user_id = ? AND b.active = 1`
      )
      .bind(userId),
    db.prepare("SELECT * FROM telegram_sessions WHERE telegram_user_id = ? AND expires_at > datetime('now')").bind(userId),
  ]);
  return {
    claimed: (claim.meta.changes ?? 0) === 1,
    withinLimit: withinRateLimit(rate),
    connection: (connection.results[0] as TelegramConnection | undefined) ?? null,
    branch: (branch.results[0] as Branch | undefined) ?? null,
    session: (session.results[0] as TelegramSession | undefined) ?? null,
  };
}

// ---------- Conversation sessions (30-minute TTL) ----------

export function getSession(db: D1Database, userId: string): Promise<TelegramSession | null> {
  return db
    .prepare("SELECT * FROM telegram_sessions WHERE telegram_user_id = ? AND expires_at > datetime('now')")
    .bind(userId)
    .first<TelegramSession>();
}

export async function saveSession(
  db: D1Database,
  userId: string,
  branchId: number,
  flow: string,
  step: string,
  data: unknown
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO telegram_sessions (telegram_user_id, branch_id, flow, step, data_json, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '+30 minutes'))
     ON CONFLICT (telegram_user_id) DO UPDATE SET branch_id = excluded.branch_id, flow = excluded.flow,
       step = excluded.step, data_json = excluded.data_json, expires_at = excluded.expires_at,
       updated_at = datetime('now')`
    )
    .bind(userId, branchId, flow, step, JSON.stringify(data))
    .run();
}

export async function clearSession(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM telegram_sessions WHERE telegram_user_id = ?').bind(userId).run();
}

// ---------- Invoice attachments ----------

export async function addInvoiceAttachment(
  db: D1Database,
  input: {
    invoice_id: number;
    bytes: Uint8Array;
    mime: string;
    filename: string;
    size_bytes: number;
    telegramFileId: string;
    telegramFileUniqueId: string;
    telegramUserId: string;
  }
): Promise<'stored' | 'duplicate'> {
  const sha = await sha256Hex(input.bytes);
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO invoice_attachments
     (invoice_id, bytes, mime, filename, size_bytes, sha256, telegram_file_id, telegram_file_unique_id, uploaded_by_telegram_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.invoice_id,
      input.bytes,
      input.mime,
      input.filename,
      input.size_bytes,
      sha,
      input.telegramFileId,
      input.telegramFileUniqueId,
      input.telegramUserId
    )
    .run();
  return (result.meta.changes ?? 0) ? 'stored' : 'duplicate';
}

function normalizeBlob(value: ArrayBuffer | number[]): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value);
}

type AttachmentRow = InvoiceAttachmentMeta & { bytes: ArrayBuffer | number[] };

export async function listInvoiceAttachments(db: D1Database, invoiceId: number): Promise<InvoiceAttachment[]> {
  const rows = (
    await db
      .prepare(
        'SELECT id, invoice_id, bytes, mime, filename, size_bytes FROM invoice_attachments WHERE invoice_id = ? ORDER BY id'
      )
      .bind(invoiceId)
      .all<AttachmentRow>()
  ).results;
  return rows.map((row) => ({ ...row, bytes: normalizeBlob(row.bytes) }));
}

export async function listInvoiceAttachmentMeta(db: D1Database, invoiceId: number): Promise<InvoiceAttachmentMeta[]> {
  return (
    await db
      .prepare('SELECT id, invoice_id, mime, filename, size_bytes FROM invoice_attachments WHERE invoice_id = ? ORDER BY id')
      .bind(invoiceId)
      .all<InvoiceAttachmentMeta>()
  ).results;
}

export async function getInvoiceAttachment(
  db: D1Database,
  invoiceId: number,
  attachmentId: number
): Promise<InvoiceAttachment | null> {
  const row = await db
    .prepare(
      'SELECT id, invoice_id, bytes, mime, filename, size_bytes FROM invoice_attachments WHERE id = ? AND invoice_id = ?'
    )
    .bind(attachmentId, invoiceId)
    .first<AttachmentRow>();
  return row ? { ...row, bytes: normalizeBlob(row.bytes) } : null;
}

export function asEmailAttachments(attachments: InvoiceAttachment[]): EmailAttachment[] {
  return attachments.map((a) => ({ filename: a.filename, type: a.mime, content: a.bytes }));
}

/** Daily housekeeping (cron). */
export async function purgeTelegramData(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM telegram_sessions WHERE expires_at <= datetime('now')"),
    db.prepare("DELETE FROM telegram_link_tokens WHERE expires_at <= datetime('now')"),
    db.prepare("DELETE FROM telegram_processed_updates WHERE processed_at < datetime('now', '-7 days')"),
    db.prepare("DELETE FROM telegram_rate_limits WHERE window_start < datetime('now', '-1 day')"),
  ]);
}
