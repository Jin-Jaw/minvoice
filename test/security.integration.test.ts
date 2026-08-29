import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient, createInvoice, getInvoice } from '../src/db/queries';

const DB = env.DB;

async function loginCookie(): Promise<string> {
  const response = await exports.default.fetch(
    new Request('https://invoice.test/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: 'password=integration-test-password',
      redirect: 'manual',
    })
  );
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM email_outbox'),
    DB.prepare('DELETE FROM payments'),
    DB.prepare('DELETE FROM invoice_events'),
    DB.prepare('DELETE FROM invoice_items'),
    DB.prepare('DELETE FROM invoices'),
    DB.prepare('DELETE FROM clients'),
    DB.prepare(`UPDATE settings SET setup_complete = 1 WHERE id = 1`),
  ]);
});

describe('browser and public-route hardening', () => {
  it('serves authenticated HTML with a strict CSP and matching per-response nonce', async () => {
    const response = await exports.default.fetch(
      new Request('https://invoice.test/admin', { headers: { cookie: await loginCookie() } })
    );
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("style-src-attr 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');

    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(await response.text()).toContain(`nonce="${nonce}"`);
  });

  it('does not expose draft print or PDF documents through the public capability route', async () => {
    const clientId = await createClient(DB, {
      name: 'Draft Client',
      email: 'draft@example.test',
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    const id = await createInvoice(DB, {
      client_id: clientId,
      issue_date: '2026-08-29',
      due_date: null,
      subject: null,
      notes: null,
      items: [{ description: 'Unfinished work', quantity: 1, unit_price_cents: 10000 }],
    });
    const token = (await getInvoice(DB, id))!.public_token;

    for (const suffix of ['/print', '/pdf']) {
      const response = await exports.default.fetch(new Request(`https://invoice.test/pay/${token}${suffix}`));
      expect(response.status).toBe(404);
    }
  });

  it('rejects oversized webhook requests before a handler buffers them', async () => {
    const response = await exports.default.fetch(
      new Request('https://invoice.test/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: 'x'.repeat(300 * 1024) }),
      })
    );
    expect(response.status).toBe(413);
  });
});
