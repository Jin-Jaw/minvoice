import { currencyOptions } from '../../lib/money';
import type { Branch } from '../../db/queries';
import { Layout } from '../layout';

export function BranchesPage({
  branches,
  currentBranchId,
  error,
  nonce,
}: {
  branches: Branch[];
  currentBranchId: number;
  error?: string;
  nonce?: string;
}) {
  return (
    <Layout title="Branches" currentPath="/admin/branches" nonce={nonce}>
      <div class="page-head">
        <div>
          <h1 class="page-title">Invoice branches</h1>
          <p class="muted">Clients are shared. Branding, numbering, invoices, payments, and reports follow the selected branch.</p>
        </div>
      </div>

      {error ? <div class="banner banner-error">{error}</div> : null}

      <div class="card">
        <h2>Switch branch</h2>
        <div class="branch-list">
          {branches.map((branch) => (
            <div class="branch-row">
              <div>
                <strong>{branch.name}</strong>
                <div class="muted">
                  {branch.currency} · {branch.invoice_prefix || 'No prefix'}
                  {branch.business_address ? ` · ${branch.business_address.split('\n')[0]}` : ''}
                </div>
              </div>
              {branch.id === currentBranchId ? (
                <span class="badge badge-paid">Current</span>
              ) : (
                <form method="post" action="/admin/branches/switch">
                  <input type="hidden" name="branch_id" value={String(branch.id)} />
                  <button type="submit" class="btn btn-secondary btn-sm">Switch</button>
                </form>
              )}
            </div>
          ))}
        </div>
      </div>

      <div class="card">
        <h2>Add another branch</h2>
        <p class="muted">The new branch starts empty but immediately uses the same client list and shared app configuration.</p>
        <form method="post" action="/admin/branches">
          <div class="form-row">
            <div class="form-group">
              <label for="branch_name">Branch or trading name</label>
              <input id="branch_name" name="name" required maxlength={120} />
            </div>
            <div class="form-group">
              <label for="branch_currency">Default currency</label>
              <select id="branch_currency" name="currency">
                {currencyOptions().map((currency) => (
                  <option value={currency.code} selected={currency.code === 'GBP'}>
                    {currency.code} — {currency.name}
                  </option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label for="branch_prefix">Invoice prefix</label>
              <input id="branch_prefix" name="invoice_prefix" value="INV-" maxlength={40} required />
            </div>
          </div>
          <div class="form-group">
            <label for="branch_address">Business address</label>
            <textarea id="branch_address" name="business_address" rows={4} required></textarea>
          </div>
          <div class="form-group">
            <label for="branch_email">Business email</label>
            <input id="branch_email" name="business_email" type="email" />
          </div>
          <button type="submit" class="btn btn-primary">Add and switch</button>
        </form>
      </div>
    </Layout>
  );
}

