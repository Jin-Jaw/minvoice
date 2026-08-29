import { Layout } from '../layout';
import { LOCALE_OPTIONS } from '../../lib/strings';
import {
  CLIENT_RATE_CURRENCIES,
  formatCents,
  isClientRateCurrency,
  type ClientRateCurrency,
} from '../../lib/money';
import { Icon } from '../icons';
import type { Client } from '../../db/queries';

function RateCurrencySelect({ selected }: { selected: ClientRateCurrency }) {
  return (
    <select id="default_currency" name="default_currency" required>
      {CLIENT_RATE_CURRENCIES.map((currency) => (
        <option value={currency} selected={currency === selected}>
          {currency}
        </option>
      ))}
    </select>
  );
}

export function ClientsPage({
  currentPath,
  clients,
  error,
  nonce,
}: {
  currentPath: string;
  clients: Client[];
  error?: string;
  nonce?: string;
}) {
  return (
    <Layout title="Clients" currentPath={currentPath} nonce={nonce}>
      <div class="page-head">
        <h1 class="page-title">Clients</h1>
        <div class="actions">
          <a class="btn btn-primary" href="/admin/clients/new">
            <Icon name="plus" />
            New client
          </a>
        </div>
      </div>

      {error ? <div class="banner banner-error">{error}</div> : null}

      {clients.length === 0 ? (
        <div class="empty-state">
          <p>No clients yet.</p>
        </div>
      ) : (
        <table class="table table--stack">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Rate</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr>
                <td data-label="Name">{client.name}</td>
                <td data-label="Email">{client.email ?? <span class="muted">—</span>}</td>
                <td data-label="Rate">
                  {client.default_rate_cents != null ? (
                    formatCents(client.default_rate_cents, client.default_currency ?? 'GBP')
                  ) : (
                    <span class="muted">default</span>
                  )}
                </td>
                <td data-label="Status">
                  {client.archived ? (
                    <span class="badge badge-void">archived</span>
                  ) : (
                    <span class="badge badge-paid">active</span>
                  )}
                </td>
                <td>
                  <a href={`/admin/clients/${client.id}`}>Edit</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

    </Layout>
  );
}

export function ClientNewPage({
  currentPath,
  defaultCurrency,
  nonce,
}: {
  currentPath: string;
  defaultCurrency: ClientRateCurrency;
  nonce?: string;
}) {
  return (
    <Layout title="New client" currentPath={currentPath} nonce={nonce}>
      <div class="page-head">
        <h1 class="page-title">New client</h1>
      </div>

      <div class="card">
        <form method="post" action="/admin/clients">
          <div class="form-group">
            <label for="name">Name</label>
            <input type="text" id="name" name="name" required />
          </div>
          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" />
          </div>
          <div class="form-group">
            <label for="address">Address</label>
            <textarea id="address" name="address"></textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="default_rate">Default invoice rate</label>
              <input type="text" id="default_rate" name="default_rate" placeholder="Inherit from settings" />
              <span class="muted">
                Fills the unit price on new invoices for this client. Leave blank to use the rate in Settings;
                you can still change it on each invoice.
              </span>
            </div>
            <div class="form-group">
              <label for="default_currency">Rate currency</label>
              <RateCurrencySelect selected={defaultCurrency} />
              <span class="muted">Applied automatically when you select this client.</span>
            </div>
          </div>
          <div class="form-group">
            <label for="payment_terms_days">Payment terms (days)</label>
            <input type="number" id="payment_terms_days" name="payment_terms_days" min="0" placeholder="Inherit from settings" />
            <span class="muted">
              Sets the default due date to this many days after the invoice date. Leave blank to use Settings.
            </span>
          </div>
          <div class="form-group">
            <label for="locale">Language &amp; region</label>
            <select id="locale" name="locale">
              <option value="">Inherit from settings</option>
              {LOCALE_OPTIONS.map((l) => (
                <option value={l.tag}>{l.label}</option>
              ))}
              <option value="__custom__">Custom tag…</option>
            </select>
            <input
              type="text"
              id="locale_custom"
              name="locale_custom"
              hidden
              autocomplete="off"
              placeholder="BCP-47 tag, e.g. en-NZ, es-CL, pl"
            />
            <span class="muted">Language for this client's emails, pay page, and PDF.</span>
          </div>
          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Add client
            </button>
            <a class="btn btn-secondary" href="/admin/clients">
              Cancel
            </a>
          </div>
        </form>
      </div>
      <script
        nonce={nonce}
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  var sel = document.getElementById('locale'), inp = document.getElementById('locale_custom');
  if (!sel || !inp) return;
  sel.addEventListener('change', function () {
    inp.hidden = sel.value !== '__custom__';
    if (!inp.hidden) inp.focus();
  });
})();
`,
        }}
      ></script>
    </Layout>
  );
}

export function ClientEditPage({ currentPath, client, nonce }: { currentPath: string; client: Client; nonce?: string }) {
  const selectedCurrency =
    client.default_currency && isClientRateCurrency(client.default_currency) ? client.default_currency : 'GBP';
  return (
    <Layout title={`Edit ${client.name}`} currentPath={currentPath} nonce={nonce}>
      <div class="page-head">
        <h1 class="page-title">Edit client</h1>
      </div>

      <div class="card">
        <form method="post" action={`/admin/clients/${client.id}`}>
          <div class="form-group">
            <label for="name">Name</label>
            <input type="text" id="name" name="name" value={client.name} required />
          </div>
          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" value={client.email ?? ''} />
          </div>
          <div class="form-group">
            <label for="address">Address</label>
            <textarea id="address" name="address">
              {client.address ?? ''}
            </textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="default_rate">Default invoice rate</label>
              <input
                type="text"
                id="default_rate"
                name="default_rate"
                value={client.default_rate_cents != null ? (client.default_rate_cents / 100).toFixed(2) : ''}
                placeholder="Inherit from settings"
              />
              <span class="muted">
                Fills the unit price on new invoices for this client. Leave blank to use the rate in Settings;
                you can still change it on each invoice.
              </span>
            </div>
            <div class="form-group">
              <label for="default_currency">Rate currency</label>
              <RateCurrencySelect selected={selectedCurrency} />
              <span class="muted">Applied automatically when you select this client.</span>
            </div>
          </div>
          <div class="form-group">
            <label for="payment_terms_days">Payment terms (days)</label>
            <input
              type="number"
              id="payment_terms_days"
              name="payment_terms_days"
              min="0"
              value={client.payment_terms_days != null ? String(client.payment_terms_days) : ''}
              placeholder="Inherit from settings"
            />
            <span class="muted">
              Sets the default due date to this many days after the invoice date. Leave blank to use Settings.
            </span>
          </div>
          <div class="form-group">
            <label for="locale">Language &amp; region</label>
            <select id="locale" name="locale">
              <option value="" selected={!client.locale}>
                Inherit from settings
              </option>
              {LOCALE_OPTIONS.map((l) => (
                <option value={l.tag} selected={l.tag === client.locale}>
                  {l.label}
                </option>
              ))}
              {client.locale && !LOCALE_OPTIONS.some((l) => l.tag === client.locale) ? (
                <option value={client.locale} selected>
                  {client.locale}
                </option>
              ) : null}
              <option value="__custom__">Custom tag…</option>
            </select>
            <input
              type="text"
              id="locale_custom"
              name="locale_custom"
              hidden
              autocomplete="off"
              placeholder="BCP-47 tag, e.g. en-NZ, es-CL, pl"
            />
            <span class="muted">Language for this client's emails, pay page, and PDF.</span>
          </div>
          <div class="form-group">
            <label>
              <input
                type="checkbox"
                name="archived"
                value="1"
                checked={!!client.archived}
                class="client-archive-checkbox"
              />
              Archived
            </label>
          </div>
          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Save changes
            </button>
            <a class="btn btn-secondary" href="/admin/clients">
              Cancel
            </a>
          </div>
        </form>
      </div>
      <script
        nonce={nonce}
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  var sel = document.getElementById('locale'), inp = document.getElementById('locale_custom');
  if (!sel || !inp) return;
  sel.addEventListener('change', function () {
    inp.hidden = sel.value !== '__custom__';
    if (!inp.hidden) inp.focus();
  });
})();
`,
        }}
      ></script>
    </Layout>
  );
}
