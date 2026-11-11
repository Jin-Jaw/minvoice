import type { Branch, Expense } from '../../db/queries';
import { formatDateHuman } from '../../lib/dates';
import { MAX_GOLD_OUNCES } from '../../lib/gold';
import { formatCents } from '../../lib/money';
import { Layout } from '../layout';

export type GoldFormValues = { ounces: string; price: string; purchase_date: string };

/** Gold held by Jin&Jaw Arabia: the holding, a form to record a purchase, and past purchases. */
export function GoldPage({
  branch,
  purchases,
  values,
  currency,
  error,
  saved,
  nonce,
}: {
  /** Null when the open workspace is not the one that holds gold. */
  branch: Branch | null;
  purchases: Expense[];
  values: GoldFormValues;
  currency: string;
  error?: string;
  saved?: boolean;
  nonce?: string;
}) {
  const ounces = purchases.reduce((sum, purchase) => sum + (purchase.gold_ounces ?? 0), 0);
  const paid = new Map<string, number>();
  for (const purchase of purchases) paid.set(purchase.currency, (paid.get(purchase.currency) ?? 0) + purchase.amount_cents);
  return (
    <Layout title="Gold" currentPath="/admin/expenses" nonce={nonce}>
      <div class="page-head">
        <div>
          <h1 class="page-title">Gold</h1>
          <p class="muted">
            Gold ounces bought{branch ? ` for ${branch.name}` : ''}. Each purchase is also an expense, so it lowers cash in reports. The gold held counts as an asset there, in ounces.
          </p>
        </div>
        <div class="actions">
          <a class="btn btn-secondary" href="/admin/expenses">Back to expenses</a>
        </div>
      </div>

      {!branch ? (
        <div class="empty-state"><p>Gold is bought for Jin&amp;Jaw Arabia. Switch to that workspace to record a purchase.</p></div>
      ) : (
        <>
          {saved ? <div class="banner banner-success">Gold purchase saved.</div> : null}
          {error ? <div class="banner banner-error">{error}</div> : null}

          <div class="stat-grid">
            <div class="card stat">
              <span class="stat-label">Gold held</span>
              <span class="stat-value">{ounces} oz</span>
            </div>
            <div class="card stat">
              <span class="stat-label">Paid for gold held</span>
              {paid.size === 0 ? <span class="stat-value">{formatCents(0, currency)}</span> : null}
              {[...paid].map(([code, cents]) => <span class="stat-value">{formatCents(cents, code)}</span>)}
            </div>
          </div>

          <div class="card">
            <h2>Buy gold</h2>
            <form method="post" action="/admin/gold">
              <div class="form-row">
                <div class="form-group">
                  <label for="gold_ounces">Ounces</label>
                  <input id="gold_ounces" name="ounces" type="number" min="1" max={MAX_GOLD_OUNCES} step="1" value={values.ounces} required />
                </div>
                <div class="form-group">
                  <label for="gold_price">Price per ounce ({currency})</label>
                  <input id="gold_price" name="price" inputmode="decimal" value={values.price} required placeholder="0.00" />
                </div>
                <div class="form-group">
                  <label for="gold_date">Purchase date</label>
                  <input id="gold_date" name="purchase_date" type="date" value={values.purchase_date} required />
                </div>
              </div>
              <div class="actions">
                <button type="submit" class="btn btn-primary">Buy gold</button>
              </div>
            </form>
          </div>

          {purchases.length === 0 ? (
            <div class="empty-state"><p>No gold bought yet.</p></div>
          ) : (
            <table class="table table--stack">
              <thead>
                <tr>
                  <th>Date</th>
                  <th class="text-right">Ounces</th>
                  <th class="text-right">Price per ounce</th>
                  <th class="text-right">Total paid</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((purchase) => (
                  <tr>
                    <td data-label="Date">
                      <a href={`/admin/expenses/${purchase.id}`}>{formatDateHuman(purchase.expense_date)}</a>
                    </td>
                    <td data-label="Ounces" class="text-right">{purchase.gold_ounces}</td>
                    <td data-label="Price per ounce" class="text-right">
                      {formatCents(Math.round(purchase.amount_cents / (purchase.gold_ounces ?? 1)), purchase.currency)}
                    </td>
                    <td data-label="Total paid" class="text-right">{formatCents(purchase.amount_cents, purchase.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Layout>
  );
}
