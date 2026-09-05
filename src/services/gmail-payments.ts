import type { Bindings } from '../env';
import { getSettings, type Invoice } from '../db/queries';
import { secretConfigured } from '../lib/config';
import { unbox } from '../lib/secretbox';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_MESSAGES_PER_RUN = 25;
const MAX_JSON_BYTES = 512 * 1024;

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

type GmailProfile = { emailAddress?: string };
type GmailMessageList = { messages?: Array<{ id?: string }> };
type GmailMessage = {
  id?: string;
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: Array<{ name?: string; value?: string }> };
};

export type GmailScanResult = {
  checked: number;
  paid: number;
  review: number;
  ignored: number;
  duplicate: number;
};

export type GmailPaymentCandidate = Pick<Invoice, 'id' | 'number' | 'status' | 'total_cents' | 'currency'>;

function googleCredentials(env: Bindings): { clientId: string; clientSecret: string } {
  const clientId = (env.GMAIL_CLIENT_ID ?? '').trim();
  const clientSecret = (env.GMAIL_CLIENT_SECRET ?? '').trim();
  if (!secretConfigured(clientId) || !secretConfigured(clientSecret)) {
    throw new Error('Gmail OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET as Worker secrets.');
  }
  return { clientId, clientSecret };
}

export function gmailRedirectUri(env: Bindings): string {
  const base = (env.APP_BASE_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('APP_BASE_URL is required for the Gmail OAuth callback.');
  return `${base}/admin/settings/gmail/callback`;
}

export function gmailAuthorizationUrl(env: Bindings, state: string): string {
  const { clientId } = googleCredentials(env);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: gmailRedirectUri(env),
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.toString();
}

async function boundedJson<T>(response: Response, label: string): Promise<T> {
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_JSON_BYTES) throw new Error(`${label} response was unexpectedly large.`);
  let parsed: T;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!response.ok) {
    const detail = parsed as GoogleTokenResponse;
    throw new Error(`${label} failed: ${detail.error_description || detail.error || response.status}`);
  }
  return parsed;
}

export async function exchangeGmailCode(
  env: Bindings,
  code: string
): Promise<{ refreshToken: string; address: string }> {
  const { clientId, clientSecret } = googleCredentials(env);
  const token = await boundedJson<GoogleTokenResponse>(
    await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: gmailRedirectUri(env),
      }),
    }),
    'Google OAuth token exchange'
  );
  if (!token.access_token || !token.refresh_token) {
    throw new Error('Google did not return an offline refresh token. Reconnect Gmail and approve access.');
  }
  const profile = await gmailApi<GmailProfile>(token.access_token, '/profile');
  if (!profile.emailAddress) throw new Error('Gmail profile did not include an email address.');
  return { refreshToken: token.refresh_token, address: profile.emailAddress };
}

async function gmailAccessToken(env: Bindings, storedRefreshToken: string): Promise<string> {
  const { clientId, clientSecret } = googleCredentials(env);
  const refreshToken = await unbox(env.SETTINGS_MASTER_KEY, storedRefreshToken);
  if (!refreshToken) throw new Error('The Gmail refresh token cannot be decrypted. Restore SETTINGS_MASTER_KEY or reconnect Gmail.');
  const token = await boundedJson<GoogleTokenResponse>(
    await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    }),
    'Google OAuth token refresh'
  );
  if (!token.access_token) throw new Error('Google did not return a Gmail access token.');
  return token.access_token;
}

async function gmailApi<T>(accessToken: string, path: string): Promise<T> {
  return boundedJson<T>(
    await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } }),
    'Gmail API'
  );
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function amountTokens(totalCents: number): string[] {
  const plain = (totalCents / 100).toFixed(2);
  const grouped = (totalCents / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  });
  return [...new Set([plain, grouped])];
}

const CURRENCY_SYMBOLS: Record<string, string[]> = {
  GBP: ['£'],
  EUR: ['€'],
  USD: ['$'],
  CAD: ['C$', 'CA$'],
  AUD: ['A$', 'AU$'],
};

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsExactPaymentAmount(text: string, invoice: GmailPaymentCandidate): boolean {
  const code = invoice.currency.toUpperCase();
  for (const amount of amountTokens(invoice.total_cents)) {
    const escapedAmount = regexEscape(amount);
    const amountEnd = '(?![0-9.,])';
    if (
      new RegExp(`(?:^|[^A-Z0-9])${regexEscape(code)}\\s*${escapedAmount}${amountEnd}`, 'i').test(text) ||
      new RegExp(`(?:^|[^0-9.,])${escapedAmount}\\s*${regexEscape(code)}(?![A-Z0-9])`, 'i').test(text)
    ) return true;
    for (const symbol of CURRENCY_SYMBOLS[code] ?? []) {
      if (new RegExp(`(?:^|[^A-Z])${regexEscape(symbol)}\\s*${escapedAmount}${amountEnd}`, 'i').test(text)) return true;
    }
  }
  return false;
}

export function matchGmailPayment(
  text: string,
  invoices: GmailPaymentCandidate[]
): { kind: 'paid'; invoice: GmailPaymentCandidate } | { kind: 'ignored' | 'review'; detail: string } {
  const matches = invoices.filter(
    (invoice) =>
      invoice.status === 'sent' &&
      new RegExp(`(?:^|[^A-Z0-9])${regexEscape(invoice.number)}(?=$|[^A-Z0-9])`, 'i').test(text) &&
      containsExactPaymentAmount(text, invoice)
  );
  if (matches.length === 1) return { kind: 'paid', invoice: matches[0] };
  if (matches.length > 1) return { kind: 'review', detail: 'multiple exact invoice matches' };
  return { kind: 'ignored', detail: 'no exact sent-invoice number, amount, and currency match' };
}

function trustedSenderQuery(query: string): boolean {
  return /(?:^|\s|\{)from:[^\s{}]+@[^\s{}]+/i.test(query);
}

async function recordUnmatched(
  db: D1Database,
  messageId: string,
  result: 'ignored' | 'review',
  detail: string,
  messageDate: string | null
): Promise<'ignored' | 'review' | 'duplicate'> {
  try {
    await db
      .prepare(
        `INSERT INTO gmail_payment_events (message_id, result, detail, message_date)
         VALUES (?, ?, ?, ?)`
      )
      .bind(messageId, result, detail, messageDate)
      .run();
    return result;
  } catch (error) {
    if (String(error).includes('UNIQUE')) return 'duplicate';
    throw error;
  }
}

async function recordGmailPayment(
  db: D1Database,
  messageId: string,
  messageDate: string | null,
  invoice: GmailPaymentCandidate
): Promise<'paid' | 'review' | 'duplicate'> {
  const providerRef = `gmail:${messageId}`;
  const note = `Automatically matched from Gmail message ${messageId}`;
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO gmail_payment_events (message_id, invoice_id, result, detail, message_date)
           VALUES (?, ?, 'review', 'match changed before payment could be recorded', ?)`
        )
        .bind(messageId, invoice.id, messageDate),
      db
        .prepare(
          `INSERT INTO payments (invoice_id, provider, provider_ref, amount_cents, currency, note, created_at, recorded_at)
           SELECT id, 'manual', ?, total_cents, currency, ?, COALESCE(?, datetime('now')), datetime('now')
           FROM invoices WHERE id = ? AND status = 'sent' AND total_cents = ? AND currency = ?`
        )
        .bind(providerRef, note, messageDate, invoice.id, invoice.total_cents, invoice.currency),
      db
        .prepare(
          `UPDATE invoices SET status = 'paid', paid_at = COALESCE(?, datetime('now')), updated_at = datetime('now')
           WHERE id = ? AND status = 'sent' AND total_cents = ? AND currency = ?`
        )
        .bind(messageDate, invoice.id, invoice.total_cents, invoice.currency),
      db
        .prepare(
          `UPDATE gmail_payment_events SET result = 'paid', detail = 'exact invoice number, amount, and currency match'
           WHERE message_id = ? AND EXISTS (SELECT 1 FROM payments WHERE provider_ref = ?)`
        )
        .bind(messageId, providerRef),
    ]);
    return (results[2]?.meta.changes ?? 0) > 0 ? 'paid' : 'review';
  } catch (error) {
    if (String(error).includes('UNIQUE')) return 'duplicate';
    throw error;
  }
}

export async function scanGmailPayments(env: Bindings): Promise<GmailScanResult> {
  const result: GmailScanResult = { checked: 0, paid: 0, review: 0, ignored: 0, duplicate: 0 };
  const settings = await getSettings(env.DB);
  if (!settings.gmail_enabled || !settings.gmail_refresh_token) return result;
  const query = settings.gmail_query.trim();
  if (!trustedSenderQuery(query)) throw new Error('Gmail payment search must include a trusted from: sender filter.');

  const accessToken = await gmailAccessToken(env, settings.gmail_refresh_token);
  const params = new URLSearchParams({ q: query, maxResults: String(MAX_MESSAGES_PER_RUN), includeSpamTrash: 'false' });
  const list = await gmailApi<GmailMessageList>(accessToken, `/messages?${params}`);
  const invoices = (
    await env.DB.prepare(
      `SELECT id, number, status, total_cents, currency
       FROM invoices WHERE status = 'sent' ORDER BY id DESC`
    ).all<GmailPaymentCandidate>()
  ).results;

  for (const item of list.messages ?? []) {
    if (!item.id) continue;
    const seen = await env.DB.prepare('SELECT 1 FROM gmail_payment_events WHERE message_id = ?').bind(item.id).first();
    if (seen) {
      result.duplicate += 1;
      continue;
    }
    const message = await gmailApi<GmailMessage>(
      accessToken,
      `/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
    );
    result.checked += 1;
    const received = message.internalDate ? new Date(Number(message.internalDate)).toISOString().slice(0, 10) : null;
    const match = matchGmailPayment(`${header(message, 'Subject')}\n${header(message, 'From')}\n${message.snippet ?? ''}`, invoices);
    const outcome =
      match.kind === 'paid'
        ? await recordGmailPayment(env.DB, item.id, received, match.invoice)
        : await recordUnmatched(env.DB, item.id, match.kind, match.detail, received);
    result[outcome] += 1;
  }
  await env.DB.prepare("UPDATE settings SET gmail_last_checked_at = datetime('now') WHERE id = 1").run();
  return result;
}
