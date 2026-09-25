import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createClient,
  createExpense,
  createInvoice,
  getClientForBranch,
  linkClientToBranch,
  listClients,
  listClientsForBranch,
  reportSummary,
} from '../src/db/queries';

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

/** Re-runs 0019 against the current data. setup already applied it to the empty database. */
async function runArabiaSplit(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((candidate) => candidate.name === '0019_arabia_workspace.sql');
  expect(migration).toBeDefined();
  await DB.batch(migration!.queries.map((query) => DB.prepare(query)));
}

const clientFields = { email: null, address: null, default_rate_cents: null, payment_terms_days: null };
const oneLine = (description: string) => [{ description, quantity: 1, unit_price_cents: 10000 }];

afterEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM income_entries'),
    DB.prepare('DELETE FROM expenses'),
    DB.prepare('DELETE FROM invoice_items'),
    DB.prepare('DELETE FROM invoice_events'),
    DB.prepare('DELETE FROM invoices'),
    DB.prepare('DELETE FROM client_branches'),
    DB.prepare('DELETE FROM clients'),
    DB.prepare("DELETE FROM branches WHERE name LIKE 'Jin&Jaw Arabia%'"),
    DB.prepare("DELETE FROM workspaces WHERE slug = 'jinjaw-arabia'"),
    DB.prepare("UPDATE workspaces SET name = 'Jin&Jaw invoices' WHERE id = 1"),
  ]);
});

describe('0019 Arabia workspace split', () => {
  it('leaves a database without an Arabia company unchanged', async () => {
    await runArabiaSplit();
    const workspaces = await DB.prepare('SELECT slug FROM workspaces ORDER BY id').all<{ slug: string }>();
    expect(workspaces.results.map((row) => row.slug)).toEqual(['jinjaw', 'property-flats']);
  });

  it('moves Arabia into its own workspace and splits shared clients', async () => {
    const arabia = await DB.prepare(
      `INSERT INTO branches (name, workspace_id, currency, invoice_prefix) VALUES ('Jin&Jaw Arabia S.A.R.L', 1, 'USD', 'INV-') RETURNING id`
    ).first<{ id: number }>();
    const arabiaId = arabia!.id;

    const sharedId = await createClient(DB, { ...clientFields, name: 'Shared Client' }, 1);
    const arabiaOnlyId = await createClient(DB, { ...clientFields, name: 'Arabia Only Client' }, 1);
    const ltdOnlyId = await createClient(DB, { ...clientFields, name: 'Ltd Only Client' }, 1);
    await linkClientToBranch(DB, arabiaOnlyId, arabiaId);

    const base = { issue_date: '2026-09-01', due_date: null, subject: null, notes: null };
    const ltdInvoice = await createInvoice(DB, 1, { ...base, client_id: sharedId, items: oneLine('Ltd work') });
    const arabiaInvoice = await createInvoice(DB, arabiaId, { ...base, client_id: sharedId, items: oneLine('Arabia work') });
    await createInvoice(DB, 1, { ...base, client_id: ltdOnlyId, items: oneLine('Ltd only work') });
    const arabiaExpense = await createExpense(DB, {
      branch_id: arabiaId, client_id: sharedId, expense_date: '2026-09-02', payee: 'Supplier', category: 'Software',
      description: null, reference: null, amount_cents: 5000, tax_cents: 0, currency: 'USD',
    });
    await DB.prepare(
      `INSERT INTO income_entries (branch_id, client_id, payer, income_date, amount_cents, currency)
       VALUES (?, ?, 'Payer', '2026-09-03', 2500, 'USD')`
    ).bind(arabiaId, sharedId).run();

    await runArabiaSplit();

    const workspace = await DB.prepare(`SELECT id, name FROM workspaces WHERE slug = 'jinjaw-arabia'`).first<{ id: number; name: string }>();
    expect(workspace?.name).toBe('Jin&Jaw Arabia');
    expect((await DB.prepare('SELECT name FROM workspaces WHERE id = 1').first<{ name: string }>())?.name).toBe('Jin&Jaw Ltd');
    expect((await DB.prepare('SELECT workspace_id FROM branches WHERE id = ?').bind(arabiaId).first<{ workspace_id: number }>())?.workspace_id)
      .toBe(workspace!.id);

    const ltdClients = (await listClients(DB, true, 1)).map((client) => client.name).sort();
    const arabiaClients = await listClients(DB, true, workspace!.id);
    expect(ltdClients).toEqual(['Ltd Only Client', 'Shared Client']);
    expect(arabiaClients.map((client) => client.name).sort()).toEqual(['Arabia Only Client', 'Shared Client']);

    // The Arabia copy of the shared client takes over every Arabia record.
    const copyId = arabiaClients.find((client) => client.name === 'Shared Client')!.id;
    expect(copyId).not.toBe(sharedId);
    const clientOf = (table: string, id: number) =>
      DB.prepare(`SELECT client_id FROM ${table} WHERE id = ?`).bind(id).first<{ client_id: number }>();
    expect((await clientOf('invoices', arabiaInvoice))?.client_id).toBe(copyId);
    expect((await clientOf('invoices', ltdInvoice))?.client_id).toBe(sharedId);
    expect((await clientOf('expenses', arabiaExpense))?.client_id).toBe(copyId);
    expect((await DB.prepare('SELECT client_id FROM income_entries').first<{ client_id: number }>())?.client_id).toBe(copyId);

    // The Telegram bot lists and checks clients per company.
    expect((await listClientsForBranch(DB, arabiaId)).map((client) => client.id).sort((a, b) => a - b))
      .toEqual([arabiaOnlyId, copyId].sort((a, b) => a - b));
    expect(await getClientForBranch(DB, sharedId, arabiaId)).toBeNull();
    expect((await getClientForBranch(DB, sharedId, 1))?.id).toBe(sharedId);

    // Report totals no longer mix the two companies.
    const ltdReport = await reportSummary(DB, null, '2026-09-30', null, 1);
    const arabiaReport = await reportSummary(DB, null, '2026-09-30', null, workspace!.id);
    expect(ltdReport.outstanding_count).toBe(0);
    expect(arabiaReport.by_currency).toEqual([
      expect.objectContaining({ currency: 'USD', expense_ytd_cents: 5000, received_ytd_cents: 2500 }),
    ]);

    // Running it again changes nothing.
    await runArabiaSplit();
    expect(await listClients(DB, true, workspace!.id)).toHaveLength(2);
    expect(await DB.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE slug = 'jinjaw-arabia'`).first('n')).toBe(1);
  });

  it('lists every workspace in the switcher and selects the active one', async () => {
    await DB.prepare(`INSERT INTO branches (name, workspace_id) VALUES ('Jin&Jaw Arabia S.A.R.L', 1)`).run();
    await DB.prepare(`UPDATE settings SET setup_complete = 1 WHERE id = 1`).run();
    await runArabiaSplit();
    const workspace = await DB.prepare(`SELECT id FROM workspaces WHERE slug = 'jinjaw-arabia'`).first<{ id: number }>();

    const response = await exports.default.fetch(
      new Request(`https://invoice.test/admin?workspace=${workspace!.id}`, { headers: { cookie: await loginCookie() } })
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<option value="1">Jin&amp;Jaw Ltd</option>');
    expect(html).toContain('<option value="2">Property / Flats</option>');
    expect(html).toContain(`<option value="${workspace!.id}" selected="">Jin&amp;Jaw Arabia</option>`);
  });
});
