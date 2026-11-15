import type { Branch, SafeBalance, SafeCount } from '../../db/queries';
import { formatDateHuman } from '../../lib/dates';
import { formatCents } from '../../lib/money';
import { Layout } from '../layout';

export type SafeFormValues = { amount: string; currency: string; counted_on: string; note: string };

/** Money and gold Jin&Jaw Arabia holds right now, with a form to record a count. */
export function SafePage({
  branch,
  balances,
  counts,
  goldOunces,
  values,
  error,
  saved,
  nonce,
}: {
  /** Null when the open workspace is not Jin&Jaw Arabia. */
  branch: Branch | null;
  balances: SafeBalance[];
  counts: SafeCount[];
  goldOunces: number;
  values: SafeFormValues;
  error?: string;
  saved?: boolean;
  nonce?: string;
}) {
  return (
    <Layout title="Safe" currentPath="/admin/reports" nonce={nonce}>
      <div class="page-head">
        <div>
          <h1 class="page-title">Safe</h1>
          <p class="muted">
            What {branch ? branch.name : 'the company'} holds right now, in the safe and the bank. It starts from the
            last count and follows every payment, income entry and expense after it. It does not reset each year.
          </p>
        </div>
        <div class="actions">
          <a class="btn btn-secondary" href="/admin/reports">Back to reports</a>
        </div>
      </div>

      {!branch ? (
        <div class="empty-state"><p>The safe belongs to Jin&amp;Jaw Arabia. Switch to that workspace to see it.</p></div>
      ) : (
        <>
          {saved ? <div class="banner banner-success">Saved.</div> : null}
          {error ? <div class="banner banner-error">{error}</div> : null}

          <div class="stat-grid">
            <div class="card stat">
              <span class="stat-label">Held now</span>
              {balances.length === 0 ? <span class="muted">No count yet. Record one below.</span> : null}
              {balances.map((balance) => (
                <span class={`stat-value${balance.balance_cents < 0 ? ' stat-alert' : ''}`}>
                  {formatCents(balance.balance_cents, balance.currency)}
                </span>
              ))}
              {balances.length > 0 ? <span class="muted">last count plus received minus spent</span> : null}
            </div>
            <div class="card stat">
              <span class="stat-label">Gold held</span>
              <span class="stat-value">{goldOunces} oz</span>
              <span class="muted">
                counted in ounces, never added to cash · <a href="/admin/gold">purchases</a>
              </span>
            </div>
          </div>

          {balances.length > 0 ? (
            <table class="table table--stack">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Counted on</th>
                  <th class="text-right">Counted</th>
                  <th class="text-right">Received since</th>
                  <th class="text-right">Spent since</th>
                  <th class="text-right">Held now</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((balance) => (
                  <tr>
                    <td data-label="Currency">{balance.currency}</td>
                    <td data-label="Counted on">{formatDateHuman(balance.counted_on)}</td>
                    <td data-label="Counted" class="text-right">{formatCents(balance.counted_cents, balance.currency)}</td>
                    <td data-label="Received since" class="text-right">{formatCents(balance.received_cents, balance.currency)}</td>
                    <td data-label="Spent since" class="text-right">{formatCents(balance.spent_cents, balance.currency)}</td>
                    <td data-label="Held now" class="text-right">{formatCents(balance.balance_cents, balance.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          <div class="card">
            <h2>Record a count</h2>
            <p class="muted">
              Enter what is in the safe and the bank in one currency. A new count replaces the last one for that
              currency. Money in a currency with no count is not shown.
            </p>
            <form method="post" action="/admin/safe">
              <div class="form-row">
                <div class="form-group">
                  <label for="safe_amount">Amount</label>
                  <input id="safe_amount" name="amount" inputmode="decimal" value={values.amount} required placeholder="0.00" />
                </div>
                <div class="form-group">
                  <label for="safe_currency">Currency</label>
                  <input id="safe_currency" name="currency" value={values.currency} required maxlength={3} />
                </div>
                <div class="form-group">
                  <label for="safe_counted_on">Counted on</label>
                  <input id="safe_counted_on" name="counted_on" type="date" value={values.counted_on} required />
                </div>
              </div>
              <div class="form-group">
                <label for="safe_note">Note (optional)</label>
                <input id="safe_note" name="note" value={values.note} maxlength={200} />
              </div>
              <div class="actions">
                <button type="submit" class="btn btn-primary">Save count</button>
              </div>
            </form>
          </div>

          {counts.length > 0 ? (
            <div class="card">
              <h2>Counts</h2>
              <table class="table table--stack">
                <thead>
                  <tr>
                    <th>Counted on</th>
                    <th class="text-right">Amount</th>
                    <th>Note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {counts.map((count) => (
                    <tr>
                      <td data-label="Counted on">{formatDateHuman(count.counted_on)}</td>
                      <td data-label="Amount" class="text-right">{formatCents(count.amount_cents, count.currency)}</td>
                      <td data-label="Note">{count.note ?? <span class="muted">—</span>}</td>
                      <td class="text-right">
                        <form method="post" action={`/admin/safe/counts/${count.id}/delete`}>
                          <button type="submit" class="btn btn-secondary btn-sm">Remove</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </Layout>
  );
}
