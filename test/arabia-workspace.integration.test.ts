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
  safeBalances,
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
    DB.prepare('DELETE FROM safe_counts'),
    DB.prepare('DELETE FROM payments'),
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

  it('counts gold held as an asset on the Arabia reports page only', async () => {
    await DB.prepare(`INSERT INTO branches (name, workspace_id) VALUES ('Jin&Jaw Arabia S.A.R.L', 1)`).run();
    await DB.prepare(`UPDATE settings SET setup_complete = 1 WHERE id = 1`).run();
    await runArabiaSplit();
    const workspace = await DB.prepare(`SELECT id FROM workspaces WHERE slug = 'jinjaw-arabia'`).first<{ id: number }>();
    const branch = await DB.prepare(`SELECT id FROM branches WHERE workspace_id = ?`).bind(workspace!.id).first<{ id: number }>();
    const gold = (ounces: number) =>
      createExpense(DB, {
        branch_id: branch!.id,
        client_id: null,
        expense_date: '2026-08-15',
        payee: 'Gold purchase',
        category: 'Gold',
        description: null,
        reference: null,
        amount_cents: 400000 * ounces,
        tax_cents: 0,
        currency: 'USD',
        gold_ounces: ounces,
      });
    await gold(3);
    const voided = await gold(2);
    await DB.prepare(`UPDATE expenses SET voided_at = datetime('now') WHERE id = ?`).bind(voided).run();

    const cookie = await loginCookie();
    const page = async (query: string) =>
      (await exports.default.fetch(new Request(`https://invoice.test/admin/reports?${query}`, { headers: { cookie } }))).text();

    const arabia = await page(`workspace=${workspace!.id}`);
    expect(arabia).toContain('Gold held');
    expect(arabia).toContain('Cash plus gold');
    expect(arabia).toContain('3 oz gold');
    expect(arabia).not.toContain('5 oz');

    // Gold belongs to the company, so a client filter and other workspaces do not show it.
    expect(await page(`workspace=${workspace!.id}&client=999`)).not.toContain('Gold held');
    expect(await page('workspace=1')).not.toContain('Gold held');

    // Gold received as income adds to the gold held and stays out of the money totals.
    const addIncome = (workspaceId: number, branchId: number, fields: Record<string, string>) =>
      exports.default.fetch(
        new Request(`https://invoice.test/admin/income?workspace=${workspaceId}`, {
          method: 'POST',
          headers: { cookie, 'sec-fetch-site': 'same-origin' },
          body: new URLSearchParams({
            branch_id: String(branchId), payer: 'Gold Client', currency: 'USD', income_date: '2026-08-16', amount: '', ...fields,
          }),
          redirect: 'manual',
        })
      );
    expect((await addIncome(workspace!.id, branch!.id, { gold_ounces: '2' })).status).toBe(302);
    expect(
      await DB.prepare(`SELECT amount_cents, currency FROM income_entries WHERE payer = 'Gold Client'`).first()
    ).toEqual({ amount_cents: 200, currency: 'XAU' });

    const withIncome = await page(`workspace=${workspace!.id}`);
    expect(withIncome).toContain('5 oz gold');
    expect(withIncome).not.toContain('XAU');
    const incomeList = await (
      await exports.default.fetch(new Request(`https://invoice.test/admin/income?workspace=${workspace!.id}`, { headers: { cookie } }))
    ).text();
    expect(incomeList).toContain('2 oz gold');
    const summary = await reportSummary(DB, null, '2026-08-20', null, workspace!.id);
    expect(summary.by_currency.map((sums) => sums.currency)).toEqual(['USD']);

    // Voiding the income takes the gold back out.
    await DB.prepare(`UPDATE income_entries SET voided_at = datetime('now') WHERE payer = 'Gold Client'`).run();
    expect(await page(`workspace=${workspace!.id}`)).toContain('3 oz gold');

    // Not both an amount and ounces, no gold outside Arabia, and XAU is not a money currency.
    expect((await addIncome(workspace!.id, branch!.id, { gold_ounces: '2', amount: '10' })).status).toBe(400);
    expect((await addIncome(1, 1, { gold_ounces: '2' })).status).toBe(400);
    expect((await addIncome(workspace!.id, branch!.id, { amount: '10', currency: 'XAU' })).status).toBe(400);
    expect(await DB.prepare(`SELECT COUNT(*) AS n FROM income_entries WHERE voided_at IS NULL`).first('n')).toBe(0);
  });

  it('shows what Arabia holds now from the last count and everything after it', async () => {
    await DB.prepare(`INSERT INTO branches (name, workspace_id) VALUES ('Jin&Jaw Arabia S.A.R.L', 1)`).run();
    await DB.prepare(`UPDATE settings SET setup_complete = 1 WHERE id = 1`).run();
    await runArabiaSplit();
    const workspace = await DB.prepare(`SELECT id FROM workspaces WHERE slug = 'jinjaw-arabia'`).first<{ id: number }>();
    const branch = await DB.prepare(`SELECT id FROM branches WHERE workspace_id = ?`).bind(workspace!.id).first<{ id: number }>();
    const cookie = await loginCookie();
    const get = async (path: string) =>
      (await exports.default.fetch(new Request(`https://invoice.test/admin/${path}`, { headers: { cookie } }))).text();
    const post = (path: string, fields: Record<string, string> = {}) =>
      exports.default.fetch(
        new Request(`https://invoice.test/admin/${path}`, {
          method: 'POST',
          headers: { cookie, 'sec-fetch-site': 'same-origin' },
          body: new URLSearchParams(fields),
          redirect: 'manual',
        })
      );
    const count = (fields: Record<string, string>) =>
      post(`safe?workspace=${workspace!.id}`, { amount: '76,000', currency: 'usd', counted_on: '2026-08-10', note: '', ...fields });

    expect(await get(`safe?workspace=${workspace!.id}`)).toContain('No count yet');
    expect((await count({ note: 'Counted by hand' })).status).toBe(302);
    // Pin the time the count was saved, so rows on the count date fall clearly before or after it.
    await DB.prepare(`UPDATE safe_counts SET created_at = '2026-08-10 12:00:00'`).run();

    const spend = async (date: string, cents: number, currency = 'USD', savedAt = '2026-08-20 09:00:00') => {
      const id = await createExpense(DB, {
        branch_id: branch!.id, client_id: null, expense_date: date, payee: 'Supplier', category: 'Other',
        description: null, reference: null, amount_cents: cents, tax_cents: 0, currency,
      });
      await DB.prepare('UPDATE expenses SET created_at = ? WHERE id = ?').bind(savedAt, id).run();
      return id;
    };
    await spend('2026-08-01', 900000); // before the count: already in it
    await spend('2026-08-10', 20000, 'USD', '2026-08-10 08:00:00'); // count date, saved before the count
    await spend('2026-08-10', 30000, 'USD', '2026-08-10 15:00:00'); // count date, saved after the count
    await spend('2026-08-12', 100000);
    await spend('2026-08-12', 555500, 'GBP'); // no GBP count
    const voided = await spend('2026-08-13', 444400);
    await DB.prepare(`UPDATE expenses SET voided_at = datetime('now') WHERE id = ?`).bind(voided).run();
    await DB.prepare(
      `INSERT INTO income_entries (branch_id, payer, income_date, amount_cents, currency)
       VALUES (?1, 'Payer', '2026-08-11', 50000, 'USD'), (?1, 'Gold Client', '2026-08-11', 200, 'XAU')`
    ).bind(branch!.id).run();
    const clientId = await createClient(DB, { ...clientFields, name: 'Safe Client' }, workspace!.id);
    const invoiceId = await createInvoice(DB, branch!.id, {
      issue_date: '2026-08-01', due_date: null, subject: null, notes: null, client_id: clientId, items: oneLine('Work'),
    });
    await DB.prepare(
      `INSERT INTO payments (invoice_id, provider, provider_ref, amount_cents, currency, created_at, recorded_at)
       VALUES (?1, 'manual', 'safe-after', 10000, 'USD', '2026-08-14 00:00:00', '2026-08-14 10:00:00'),
              (?1, 'manual', 'safe-before', 77700, 'USD', '2026-08-05 00:00:00', '2026-08-05 10:00:00')`
    ).bind(invoiceId).run();

    // 76,000 counted + 500 income + 100 payment - 300 - 1,000 spent.
    expect(await safeBalances(DB, branch!.id)).toEqual([
      {
        currency: 'USD', counted_cents: 7600000, counted_on: '2026-08-10',
        received_cents: 60000, spent_cents: 130000, balance_cents: 7530000,
      },
    ]);
    const page = await get(`safe?workspace=${workspace!.id}`);
    expect(page).toContain('$75,300.00');
    expect(page).toContain('2 oz');
    expect(page).toContain('Counted by hand');
    expect(page).not.toContain('£5,555.00');
    const reports = await get(`reports?workspace=${workspace!.id}`);
    expect(reports).toContain('In the safe now');
    expect(reports).toContain('$75,300.00');

    // The safe belongs to the company: hidden by a client filter and in other workspaces.
    expect(await get(`reports?workspace=${workspace!.id}&client=${clientId}`)).not.toContain('In the safe now');
    expect(await get('reports?workspace=1')).not.toContain('In the safe now');
    expect(await get('safe?workspace=1')).toContain('Switch to that workspace');
    expect((await post('safe?workspace=1', { amount: '1', currency: 'USD', counted_on: '2026-08-10' })).status).toBe(404);

    // A newer count replaces the last one for that currency.
    expect((await count({ amount: '50000.50', counted_on: '2026-08-13' })).status).toBe(302);
    expect((await safeBalances(DB, branch!.id))[0]).toMatchObject({
      counted_cents: 5000050, received_cents: 10000, spent_cents: 0, balance_cents: 5010050,
    });

    expect((await count({ amount: '-1' })).status).toBe(400);
    expect((await count({ amount: 'lots' })).status).toBe(400);
    expect((await count({ currency: 'XAU' })).status).toBe(400);
    expect((await count({ counted_on: '2999-01-01' })).status).toBe(400);
    expect(await DB.prepare('SELECT COUNT(*) AS n FROM safe_counts').first('n')).toBe(2);

    // Removing the newer count brings the older one back.
    const newest = await DB.prepare('SELECT id FROM safe_counts ORDER BY counted_on DESC LIMIT 1').first<{ id: number }>();
    expect((await post(`safe/counts/${newest!.id}/delete?workspace=1`)).status).toBe(404);
    expect((await post(`safe/counts/${newest!.id}/delete?workspace=${workspace!.id}`)).status).toBe(302);
    expect((await safeBalances(DB, branch!.id))[0]?.balance_cents).toBe(7530000);
  });
});
