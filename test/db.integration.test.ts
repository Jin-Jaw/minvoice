import { env, exports } from 'cloudflare:workers';
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  awaitingPaymentReview,
  cancelOutboxRow,
  clearLoginAttempts,
  createBranch,
  createClient,
  createInvoice,
  deleteClient,
  enqueueReminder,
  getClient,
  getInvoice,
  getInvoiceItems,
  getPayments,
  getSettings,
  listClients,
  listInvoices,
  listDueOutbox,
  markInvoicePaidFromWebhook,
  markInvoiceSent,
  markReminderSent,
  moveClient,
  monthlyReport,
  reportSummary,
  recordLoginAttempt,
  updateInvoice,
  updateClient,
  type WebhookPayment,
} from '../src/db/queries';
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MINUTES, MAX_OUTBOX_ATTEMPTS } from '../src/lib/outbox';
import { processEmailOutbox } from '../src/services/outbox';

const DB = env.DB;
const FORCED_ITEM_FAILURE = '__FORCE_ITEM_FAILURE__';

async function installItemFailureTrigger(): Promise<void> {
  await DB.prepare(
    `CREATE TRIGGER reject_forced_invoice_item
     BEFORE INSERT ON invoice_items
     WHEN NEW.description = '${FORCED_ITEM_FAILURE}'
     BEGIN
       SELECT RAISE(ABORT, 'forced item insert failure');
     END`
  ).run();
}

async function removeItemFailureTrigger(): Promise<void> {
  await DB.exec('DROP TRIGGER IF EXISTS reject_forced_invoice_item');
}

async function seedSentInvoice(total = 10000): Promise<number> {
  const clientId = await createClient(DB, {
    name: 'Acme',
    email: 'ap@acme.test',
    address: null,
    default_rate_cents: null,
    payment_terms_days: null,
  });
  const id = await createInvoice(DB, {
    client_id: clientId,
    issue_date: '2026-07-01',
    due_date: '2026-07-10',
    subject: 'Test',
    notes: null,
    items: [{ description: 'Work', quantity: 1, unit_price_cents: total }],
  });
  await markInvoiceSent(DB, id);
  return id;
}

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

const webhookPayload = (invoiceId: number, over: Partial<WebhookPayment> = {}): WebhookPayment => ({
  provider: 'stripe',
  eventId: 'evt_1',
  eventType: 'checkout.session.completed',
  payload: '{}',
  invoiceId,
  providerRef: 'cs_1',
  amountCents: 10000,
  currency: 'GBP',
  ...over,
});

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM email_outbox'),
    DB.prepare('DELETE FROM login_attempts'),
    DB.prepare('DELETE FROM webhook_events'),
    DB.prepare('DELETE FROM payments'),
    DB.prepare('DELETE FROM invoice_events'),
    DB.prepare('DELETE FROM invoice_items'),
    DB.prepare('DELETE FROM invoices'),
    DB.prepare('DELETE FROM clients'),
    DB.prepare('DELETE FROM branch_logos WHERE branch_id != 1'),
    DB.prepare('DELETE FROM branches WHERE id != 1'),
    DB.prepare(
      `UPDATE branches SET name = 'Jin&Jaw LTD', business_address = '', business_email = 'contact@jin-jaw.co.uk',
       currency = 'GBP', invoice_prefix = 'INV-', next_invoice_number = 1, active = 1 WHERE id = 1`
    ),
    DB.prepare(
      `UPDATE settings SET email_provider = 'cloudflare', email_from = '',
       reminders_enabled = 0, last_seen_origin = '', stripe_enabled = 1 WHERE id = 1`
    ),
  ]);
  await removeItemFailureTrigger();
});

describe('shared-client branch isolation', () => {
  it('shares clients while isolating issuer settings, numbering, invoices, and reports', async () => {
    const clientId = await createClient(DB, {
      name: 'Shared Client',
      email: 'accounts@shared.test',
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    const secondBranchId = await createBranch(DB, {
      name: 'Second Branch',
      business_address: '2 Branch Street',
      business_email: 'billing@second.test',
      currency: 'EUR',
      invoice_prefix: 'SECOND-',
    });

    const firstInvoice = await createInvoice(
      DB,
      1,
      {
        client_id: clientId,
        issue_date: '2026-08-01',
        due_date: null,
        subject: null,
        notes: null,
        items: [{ description: 'First branch work', quantity: 1, unit_price_cents: 10000 }],
      },
      'SHARED-001'
    );
    const secondInvoice = await createInvoice(
      DB,
      secondBranchId,
      {
        client_id: clientId,
        issue_date: '2026-08-02',
        due_date: null,
        subject: null,
        notes: null,
        items: [{ description: 'Second branch work', quantity: 1, unit_price_cents: 20000 }],
      },
      'SHARED-001'
    );

    expect(await listClients(DB)).toHaveLength(1);
    expect((await getSettings(DB, secondBranchId)).currency).toBe('EUR');
    expect((await getSettings(DB, secondBranchId)).business_address).toBe('2 Branch Street');
    expect((await listInvoices(DB, 1)).map((invoice) => invoice.id)).toEqual([firstInvoice]);
    expect((await listInvoices(DB, secondBranchId)).map((invoice) => invoice.id)).toEqual([secondInvoice]);
    expect(await getInvoice(DB, 1, secondInvoice)).toBeNull();
    expect((await getInvoice(DB, secondBranchId, secondInvoice))?.number).toBe('SHARED-001');

    await markInvoiceSent(DB, firstInvoice);
    const firstReport = await reportSummary(DB, 1, '2026-08-29');
    const secondReport = await reportSummary(DB, secondBranchId, '2026-08-29');
    expect(firstReport.outstanding_count).toBe(1);
    expect(secondReport.outstanding_count).toBe(0);
  });
});

describe('client ordering and deletion', () => {
  it('keeps a custom client order and appends new clients', async () => {
    const first = await createClient(DB, {
      name: 'Zulu', email: null, address: null, default_rate_cents: null, payment_terms_days: null,
    });
    const second = await createClient(DB, {
      name: 'Alpha', email: null, address: null, default_rate_cents: null, payment_terms_days: null,
    });
    const third = await createClient(DB, {
      name: 'Middle', email: null, address: null, default_rate_cents: null, payment_terms_days: null,
    });

    expect((await listClients(DB)).map((client) => client.id)).toEqual([first, second, third]);
    expect(await moveClient(DB, third, 'up')).toBe(true);
    expect((await listClients(DB)).map((client) => client.id)).toEqual([first, third, second]);
    expect(await moveClient(DB, first, 'up')).toBe(false);
  });

  it('deletes unused clients but preserves clients referenced by invoices', async () => {
    const unused = await createClient(DB, {
      name: 'Unused', email: null, address: null, default_rate_cents: null, payment_terms_days: null,
    });
    expect(await deleteClient(DB, unused)).toBe('deleted');
    expect(await getClient(DB, unused)).toBeNull();

    const used = await createClient(DB, {
      name: 'Used', email: null, address: null, default_rate_cents: null, payment_terms_days: null,
    });
    await createInvoice(DB, {
      client_id: used,
      issue_date: '2026-08-30', due_date: null, subject: null, notes: null,
      items: [{ description: 'Work', quantity: 1, unit_price_cents: 10000 }],
    });
    expect(await deleteClient(DB, used)).toBe('in_use');
    expect(await getClient(DB, used)).not.toBeNull();
  });

  it('renders reorder/delete controls and protects used clients at the route', async () => {
    await DB.prepare('UPDATE settings SET setup_complete = 1 WHERE id = 1').run();
    const clientId = await createClient(DB, {
      name: 'Route Client', email: null, address: null, default_rate_cents: null, payment_terms_days: null,
    });
    await createInvoice(DB, {
      client_id: clientId,
      issue_date: '2026-08-30', due_date: null, subject: null, notes: null,
      items: [{ description: 'Work', quantity: 1, unit_price_cents: 10000 }],
    });
    const cookie = await loginCookie();
    const page = await exports.default.fetch(
      new Request('https://invoice.test/admin/clients', { headers: { cookie } })
    );
    const html = await page.text();
    expect(html).toContain(`/admin/clients/${clientId}/delete`);
    expect(html).toContain('Permanently delete Route Client?');

    const response = await exports.default.fetch(
      new Request(`https://invoice.test/admin/clients/${clientId}/delete`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
        redirect: 'manual',
      })
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/clients?error=in-use');
  });
});

describe('invoice list ordering and row actions', () => {
  it('orders invoices by newest issue date, then creation time and id', async () => {
    const clientId = await createClient(DB, {
      name: 'Order Test',
      email: null,
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    const create = (issueDate: string, number: string) =>
      createInvoice(
        DB,
        {
          client_id: clientId,
          issue_date: issueDate,
          due_date: null,
          subject: null,
          notes: null,
          items: [{ description: number, quantity: 1, unit_price_cents: 100 }],
        },
        number
      );
    const older = await create('2026-07-01', 'OLD');
    const sameDateEarlier = await create('2026-08-29', 'SAME-EARLY');
    const sameDateLater = await create('2026-08-29', 'SAME-LATE');
    await DB.prepare(`UPDATE invoices SET created_at = '2026-08-29 09:00:00' WHERE id = ?`)
      .bind(sameDateEarlier)
      .run();
    await DB.prepare(`UPDATE invoices SET created_at = '2026-08-29 10:00:00' WHERE id = ?`)
      .bind(sameDateLater)
      .run();

    expect((await listInvoices(DB, 1)).map((invoice) => invoice.id)).toEqual([
      sameDateLater,
      sameDateEarlier,
      older,
    ]);
  });

  it('marks an invoice paid from the row menu and returns to the filtered list', async () => {
    await DB.prepare('UPDATE settings SET setup_complete = 1 WHERE id = 1').run();
    const id = await seedSentInvoice();
    const invoice = (await getInvoice(DB, id))!;
    const cookie = await loginCookie();
    const response = await exports.default.fetch(
      new Request(`https://invoice.test/admin/invoices/${id}/status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          cookie,
        },
        body: `action=mark_paid&return_to=${encodeURIComponent(`/admin?status=open&client=${invoice.client_id}`)}`,
        redirect: 'manual',
      })
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `/admin?status=open&client=${invoice.client_id}&paid=${encodeURIComponent(invoice.number)}`
    );
    expect((await getInvoice(DB, id))?.status).toBe('paid');
  });
});

describe('invoice write atomicity', () => {
  it('commits a header and all line items together', async () => {
    const clientId = await createClient(DB, {
      name: 'C',
      email: null,
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    const id = await createInvoice(DB, {
      client_id: clientId,
      issue_date: '2026-07-01',
      due_date: null,
      subject: null,
      notes: null,
      items: [
        { description: 'A', quantity: 2, unit_price_cents: 500 },
        { description: 'B', quantity: 1, unit_price_cents: 2500 },
      ],
    });

    expect(await getInvoiceItems(DB, id)).toHaveLength(2);
    expect((await getInvoice(DB, id))?.total_cents).toBe(3500);
  });

  it('rolls back the header when a line-item insert fails', async () => {
    const clientId = await createClient(DB, {
      name: 'C',
      email: null,
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    await installItemFailureTrigger();
    try {
      await expect(
        createInvoice(DB, {
          client_id: clientId,
          issue_date: '2026-07-01',
          due_date: null,
          subject: 'Must roll back',
          notes: null,
          items: [
            { description: 'A', quantity: 1, unit_price_cents: 500 },
            { description: FORCED_ITEM_FAILURE, quantity: 1, unit_price_cents: 500 },
          ],
        })
      ).rejects.toThrow();
    } finally {
      await removeItemFailureTrigger();
    }

    expect(await DB.prepare('SELECT COUNT(*) FROM invoices').first<number>('COUNT(*)')).toBe(0);
    expect(await DB.prepare('SELECT COUNT(*) FROM invoice_items').first<number>('COUNT(*)')).toBe(0);
  });

  it('rolls back header and item changes when an update item fails', async () => {
    const id = await seedSentInvoice();
    await installItemFailureTrigger();
    try {
      await expect(
        updateInvoice(DB, id, {
          issue_date: '2026-07-02',
          due_date: '2026-07-20',
          subject: 'Changed',
          notes: 'Changed',
          items: [
            { description: 'Replacement', quantity: 1, unit_price_cents: 2500 },
            { description: FORCED_ITEM_FAILURE, quantity: 1, unit_price_cents: 2500 },
          ],
        })
      ).rejects.toThrow();
    } finally {
      await removeItemFailureTrigger();
    }

    const invoice = await getInvoice(DB, id);
    const items = await getInvoiceItems(DB, id);
    expect(invoice?.subject).toBe('Test');
    expect(invoice?.total_cents).toBe(10000);
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('Work');
  });
});

describe('markInvoicePaidFromWebhook', () => {
  it('records a provider payment against a draft without marking the draft paid', async () => {
    const clientId = await createClient(DB, {
      name: 'Draft Client',
      email: 'draft@example.test',
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    const id = await createInvoice(DB, {
      client_id: clientId,
      issue_date: '2026-07-01',
      due_date: '2026-07-10',
      subject: 'Still being edited',
      notes: null,
      items: [{ description: 'Work', quantity: 1, unit_price_cents: 10000 }],
    });

    expect(await markInvoicePaidFromWebhook(DB, webhookPayload(id))).toBe('recorded');
    expect((await getInvoice(DB, id))?.status).toBe('draft');
    expect(
      await DB.prepare('SELECT COUNT(*) FROM payments WHERE invoice_id = ?').bind(id).first<number>('COUNT(*)')
    ).toBe(1);
    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(0);
  });

  it('records payment, transitions invoice, and enqueues both emails', async () => {
    const id = await seedSentInvoice();
    expect(await markInvoicePaidFromWebhook(DB, webhookPayload(id))).toBe('paid');

    expect((await getInvoice(DB, id))?.status).toBe('paid');
    expect(
      await DB.prepare('SELECT COUNT(*) FROM payments WHERE invoice_id = ?').bind(id).first<number>('COUNT(*)')
    ).toBe(1);
    const outbox = await listDueOutbox(DB, MAX_OUTBOX_ATTEMPTS);
    expect(outbox.map((row) => row.kind).sort()).toEqual(['paid_notice', 'payment_receipt']);
  });

  it('is idempotent for a replayed event', async () => {
    const id = await seedSentInvoice();
    await markInvoicePaidFromWebhook(DB, webhookPayload(id));
    expect(await markInvoicePaidFromWebhook(DB, webhookPayload(id))).toBe('duplicate');

    expect(
      await DB.prepare('SELECT COUNT(*) FROM payments WHERE invoice_id = ?').bind(id).first<number>('COUNT(*)')
    ).toBe(1);
    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(2);
  });

  it('records a distinct event without re-transitioning an already-paid invoice', async () => {
    const id = await seedSentInvoice();
    await markInvoicePaidFromWebhook(DB, webhookPayload(id));
    expect(
      await markInvoicePaidFromWebhook(
        DB,
        webhookPayload(id, { eventId: 'evt_2', providerRef: 'cs_2' })
      )
    ).toBe('recorded');
    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(2);
  });

  it('rolls back the event when a later payment write fails', async () => {
    await expect(
      markInvoicePaidFromWebhook(
        DB,
        webhookPayload(999999, { eventId: 'evt_fails', providerRef: 'cs_fails' })
      )
    ).rejects.toThrow();

    expect(await DB.prepare('SELECT COUNT(*) FROM webhook_events').first<number>('COUNT(*)')).toBe(0);
    expect(await DB.prepare('SELECT COUNT(*) FROM payments').first<number>('COUNT(*)')).toBe(0);
    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(0);
  });
});

describe('reminder outbox', () => {
  it('deduplicates re-enqueue of the same invoice and reminder number', async () => {
    const id = await seedSentInvoice();
    const payload = { invoiceId: id, reminderNumber: 1 };
    await enqueueReminder(DB, payload);
    await enqueueReminder(DB, payload);

    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(1);
  });

  it('writes one reminder event when overlapping drains complete together', async () => {
    const id = await seedSentInvoice();
    await enqueueReminder(DB, {
      invoiceId: id,
      reminderNumber: 1,
    });
    const [row] = await listDueOutbox(DB, MAX_OUTBOX_ATTEMPTS);

    await Promise.all([
      markReminderSent(DB, row.id, id, 'Reminder 1 emailed'),
      markReminderSent(DB, row.id, id, 'Reminder 1 emailed'),
    ]);

    expect(
      await DB.prepare(
        `SELECT COUNT(*) FROM invoice_events WHERE invoice_id = ? AND type = 'reminder'`
      )
        .bind(id)
        .first<number>('COUNT(*)')
    ).toBe(1);
  });

  it('frees the dedup key when a pending reminder is cancelled', async () => {
    const id = await seedSentInvoice();
    const payload = { invoiceId: id, reminderNumber: 1 };
    await enqueueReminder(DB, payload);
    const [row] = await listDueOutbox(DB, MAX_OUTBOX_ATTEMPTS);
    await cancelOutboxRow(DB, row.id);
    await enqueueReminder(DB, payload);

    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(1);
  });

  it('delivers a reminder and atomically records completion through the processor', async () => {
    const id = await seedSentInvoice();
    await DB.prepare(
      `UPDATE settings SET email_provider = 'cloudflare', email_from = 'billing@example.test' WHERE id = 1`
    ).run();
    await enqueueReminder(DB, {
      invoiceId: id,
      reminderNumber: 1,
    });

    let deliveries = 0;
    const EMAIL: SendEmail = {
      async send() {
        deliveries += 1;
        return { messageId: 'test-message' };
      },
    };
    await processEmailOutbox({ ...env, EMAIL });

    expect(deliveries).toBe(1);
    expect(
      await DB.prepare('SELECT COUNT(*) FROM email_outbox WHERE sent_at IS NOT NULL').first<number>('COUNT(*)')
    ).toBe(1);
    expect(
      await DB.prepare(
        `SELECT COUNT(*) FROM invoice_events WHERE invoice_id = ? AND type = 'reminder'`
      )
        .bind(id)
        .first<number>('COUNT(*)')
    ).toBe(1);
  });

  it('cancels a queued reminder when its invoice is no longer payable', async () => {
    const id = await seedSentInvoice();
    await enqueueReminder(DB, {
      invoiceId: id,
      reminderNumber: 1,
    });
    await DB.prepare(`UPDATE invoices SET status = 'paid' WHERE id = ?`).bind(id).run();

    await processEmailOutbox(env);

    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(0);
  });

  it('the scheduled handler records delivery failures with retry backoff', async () => {
    await DB.prepare(
      `INSERT INTO email_outbox (kind, payload, dedup_key) VALUES ('reminder', '{not-json', 'broken')`
    ).run();
    const ctx = createExecutionContext();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      worker.scheduled(createScheduledController({ cron: '0 15 * * *' }), env, ctx);
      await waitOnExecutionContext(ctx);
    } finally {
      errorLog.mockRestore();
    }

    const row = await DB.prepare(
      `SELECT attempts, last_error, next_attempt_at > datetime('now') AS retry_scheduled
       FROM email_outbox WHERE dedup_key = 'broken'`
    ).first<{ attempts: number; last_error: string | null; retry_scheduled: number }>();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBeTruthy();
    expect(row?.retry_scheduled).toBe(1);
  });
});

describe('login rate limiting', () => {
  it('returns sequential counts past the configured cap', async () => {
    const ip = '203.0.113.7';
    const counts: number[] = [];
    for (let i = 0; i < 12; i++) counts.push(await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES));

    expect(counts.slice(0, 3)).toEqual([1, 2, 3]);
    expect(counts[LOGIN_MAX_ATTEMPTS - 1]).toBe(LOGIN_MAX_ATTEMPTS);
    expect(counts[LOGIN_MAX_ATTEMPTS]).toBeGreaterThan(LOGIN_MAX_ATTEMPTS);
  });

  it('parallel attempts each consume a distinct slot', async () => {
    const ip = '203.0.113.8';
    const results = await Promise.all(
      Array.from({ length: 20 }, () => recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES))
    );

    expect(new Set(results).size).toBe(20);
    expect(Math.max(...results)).toBe(20);
  });

  it('the login endpoint allows attempt ten and returns 429 for attempt eleven', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) {
      await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES);
    }
    const login = () =>
      exports.default.fetch(
        new Request('https://invoice.test/admin/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'cf-connecting-ip': ip,
            'sec-fetch-site': 'same-origin',
          },
          body: 'password=wrong',
        })
      );

    expect((await login()).status).toBe(401);
    expect((await login()).status).toBe(429);
  });

  it('clearLoginAttempts resets the counter after success', async () => {
    const ip = '203.0.113.9';
    await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES);
    await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES);
    await clearLoginAttempts(DB, ip);

    expect(await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES)).toBe(1);
  });
});

describe('client default rate currencies', () => {
  it('stores and updates the currency alongside the client default rate', async () => {
    const clientId = await createClient(DB, {
      name: 'Currency Client',
      email: null,
      address: null,
      default_rate_cents: 12500,
      default_currency: 'USD',
      payment_terms_days: null,
    });

    expect(await getClient(DB, clientId)).toMatchObject({
      default_rate_cents: 12500,
      default_currency: 'USD',
    });

    await updateClient(DB, clientId, {
      name: 'Currency Client',
      email: null,
      address: null,
      archived: 0,
      default_rate_cents: 14000,
      default_currency: 'EUR',
      payment_terms_days: null,
      locale: null,
    });

    expect(await getClient(DB, clientId)).toMatchObject({
      default_rate_cents: 14000,
      default_currency: 'EUR',
    });
  });

  it('renders each client currency for the new-invoice default', async () => {
    await createClient(DB, {
      name: 'Euro Client',
      email: null,
      address: null,
      default_rate_cents: 9900,
      default_currency: 'EUR',
      payment_terms_days: null,
    });

    const response = await exports.default.fetch(
      new Request('https://invoice.test/admin/invoices/new', { headers: { cookie: await loginCookie() } })
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-rate="99.00"');
    expect(html).toContain('data-currency="EUR"');
    expect(html).toContain('applyCurrency()');
  });

  it('rejects client rate currencies outside USD, GBP, and EUR', async () => {
    const response = await exports.default.fetch(
      new Request('https://invoice.test/admin/clients', {
        method: 'POST',
        headers: {
          cookie: await loginCookie(),
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
        },
        body: new URLSearchParams({ name: 'CAD Client', default_rate: '100', default_currency: 'CAD' }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('USD, GBP, or EUR');
    expect(await DB.prepare('SELECT COUNT(*) FROM clients').first<number>('COUNT(*)')).toBe(0);
  });
});

describe('written payment instructions only', () => {
  it('removes online payment configuration from Settings', async () => {
    const response = await exports.default.fetch(
      new Request('https://invoice.test/admin/settings', { headers: { cookie: await loginCookie() } })
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('<h2>Payments</h2>');
    expect(html).not.toContain('Stripe secret key');
    expect(html).not.toContain('PayPal client ID');
    expect(html).not.toContain('No payment methods are enabled');
  });

  it('shows written instructions and exposes no checkout endpoints', async () => {
    const id = await seedSentInvoice();
    await DB.prepare('UPDATE invoices SET notes = ? WHERE id = ?')
      .bind('Bank transfer: use invoice number as the reference.', id)
      .run();
    const invoice = (await getInvoice(DB, id))!;

    const page = await exports.default.fetch(
      new Request(`https://invoice.test/pay/${invoice.public_token}`, { headers: { 'user-agent': 'Mozilla/5.0' } })
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Bank transfer: use invoice number as the reference.');
    expect(html).toContain('Please use the payment details provided on this invoice.');
    expect(html).not.toContain(`/pay/${invoice.public_token}/stripe`);
    expect(html).not.toContain(`/pay/${invoice.public_token}/paypal`);

    for (const suffix of ['/stripe', '/paypal', '/paypal/return']) {
      const response = await exports.default.fetch(
        new Request(`https://invoice.test/pay/${invoice.public_token}${suffix}`, { method: 'POST' })
      );
      expect(response.status).toBe(404);
    }
  });
});

describe('multi-currency invoices and reports', () => {
  async function seedTwoCurrencies(): Promise<{ gbp: number; eur: number }> {
    const clientId = await createClient(DB, {
      name: 'Global GmbH',
      email: 'ap@global.test',
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    const gbp = await createInvoice(DB, {
      client_id: clientId,
      issue_date: '2026-07-01',
      due_date: null,
      subject: null,
      notes: null,
      items: [{ description: 'Design', quantity: 1, unit_price_cents: 10000 }],
    });
    const eur = await createInvoice(DB, {
      client_id: clientId,
      issue_date: '2026-07-02',
      due_date: null,
      subject: null,
      notes: null,
      currency: 'EUR',
      items: [{ description: 'Dev', quantity: 1, unit_price_cents: 5000 }],
    });
    await markInvoiceSent(DB, gbp);
    await markInvoiceSent(DB, eur);
    return { gbp, eur };
  }

  it('createInvoice takes the draft currency, defaulting to settings', async () => {
    const { gbp, eur } = await seedTwoCurrencies();
    expect((await getInvoice(DB, gbp))!.currency).toBe('GBP');
    expect((await getInvoice(DB, eur))!.currency).toBe('EUR');
  });

  it('updateInvoice can change the currency and keeps it when omitted', async () => {
    const { gbp } = await seedTwoCurrencies();
    const items = [{ description: 'Design', quantity: 1, unit_price_cents: 10000 }];
    await updateInvoice(DB, gbp, {
      issue_date: '2026-07-01', due_date: null, subject: null, notes: null, currency: 'GBP', items,
    });
    expect((await getInvoice(DB, gbp))!.currency).toBe('GBP');
    await updateInvoice(DB, gbp, {
      issue_date: '2026-07-01', due_date: null, subject: null, notes: null, items,
    });
    expect((await getInvoice(DB, gbp))!.currency).toBe('GBP');
  });

  it('report sums are grouped per currency, never added together', async () => {
    const { eur } = await seedTwoCurrencies();
    await markInvoicePaidFromWebhook(
      DB,
      webhookPayload(eur, { amountCents: 5000, currency: 'EUR', providerRef: 'cs_eur', eventId: 'evt_eur' })
    );

    const today = new Date().toISOString().slice(0, 10);
    const summary = await reportSummary(DB, today);
    expect(summary.outstanding_count).toBe(1);
    expect(summary.by_currency).toEqual([
      { currency: 'EUR', outstanding_cents: 0, received_ytd_cents: 5000 },
      { currency: 'GBP', outstanding_cents: 10000, received_ytd_cents: 0 },
    ]);

    const invoiced = (await monthlyReport(DB))
      .filter((r) => r.ym === '2026-07' && r.invoiced_count > 0)
      .map((r) => [r.currency, r.invoiced_cents]);
    expect(invoiced).toEqual([
      ['EUR', 5000],
      ['GBP', 10000],
    ]);
  });
});

describe('stale-currency/amount webhooks', () => {
  it('records the payment but refuses the paid transition on mismatch', async () => {
    const id = await seedSentInvoice(10000); // GBP 100.00
    // Invoice edited to EUR after the checkout session was created
    await updateInvoice(DB, id, {
      issue_date: '2026-07-01', due_date: '2026-07-10', subject: 'Test', notes: null,
      currency: 'EUR',
      items: [{ description: 'Work', quantity: 1, unit_price_cents: 10000 }],
    });

    expect(await markInvoicePaidFromWebhook(DB, webhookPayload(id))).toBe('recorded'); // GBP 10000
    expect((await getInvoice(DB, id))?.status).toBe('sent'); // NOT paid
    expect(
      await DB.prepare('SELECT COUNT(*) FROM payments WHERE invoice_id = ?').bind(id).first<number>('COUNT(*)')
    ).toBe(1); // money moved — payment row kept for manual review
    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(0); // no receipts

    // A payment matching the CURRENT currency and total still transitions
    expect(
      await markInvoicePaidFromWebhook(
        DB,
        webhookPayload(id, { currency: 'EUR', eventId: 'evt_eur', providerRef: 'cs_eur' })
      )
    ).toBe('paid');
    expect((await getInvoice(DB, id))?.status).toBe('paid');
  });

  it('refuses the transition on an amount mismatch too', async () => {
    const id = await seedSentInvoice(10000);
    expect(await markInvoicePaidFromWebhook(DB, webhookPayload(id, { amountCents: 5000 }))).toBe('recorded');
    expect((await getInvoice(DB, id))?.status).toBe('sent');
  });
});

describe('awaitingPaymentReview', () => {
  it('suppresses checkout after a mismatched provider payment', async () => {
    const id = await seedSentInvoice(10000);
    // stale payment recorded, invoice stays sent (mismatch guard)
    await markInvoicePaidFromWebhook(DB, webhookPayload(id, { amountCents: 5000 }));
    const invoice = (await getInvoice(DB, id))!;
    expect(invoice.status).toBe('sent');
    expect(awaitingPaymentReview(invoice, await getPayments(DB, id))).toBe(true);
  });

  it('ignores manual partial payments and undone provider payments', async () => {
    const id = await seedSentInvoice(10000);
    expect(awaitingPaymentReview({ status: 'sent' }, [])).toBe(false);
    // manual partial payment: checkout stays available
    expect(awaitingPaymentReview({ status: 'sent' }, [{ provider: 'manual', undone_at: null }])).toBe(false);
    // undone provider payment: resolved by the admin, checkout is back
    expect(awaitingPaymentReview({ status: 'sent' }, [{ provider: 'stripe', undone_at: '2026-07-19' }])).toBe(false);
    // paid invoices are handled by status, not review state
    expect(awaitingPaymentReview({ status: 'paid' }, [{ provider: 'stripe', undone_at: null }])).toBe(false);
    void id;
  });
});
