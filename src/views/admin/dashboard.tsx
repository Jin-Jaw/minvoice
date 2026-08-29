import { Layout } from '../layout';
import { formatCents } from '../../lib/money';
import { formatDateHuman } from '../../lib/dates';
import { isOverdue, type InvoiceWithClient } from '../../db/queries';
import { Icon } from '../icons';

/** Per-status delete warning — same stakes as the detail page's delete button. */
function deleteConfirm(inv: Pick<InvoiceWithClient, 'status' | 'number'>): string {
  if (inv.status === 'draft') return 'Delete this draft invoice? This cannot be undone.';
  if (inv.status === 'paid') {
    return `Delete PAID invoice ${inv.number}? Its payment records are deleted too — reports and CSV exports will change. This cannot be undone.`;
  }
  return `Delete invoice ${inv.number}? Its client-facing record and history will be erased. This cannot be undone.`;
}

export function StatusBadge({
  invoice,
  today,
}: {
  invoice: Pick<InvoiceWithClient, 'status' | 'due_date'>;
  today?: string;
}) {
  if (isOverdue(invoice, today)) {
    return <span class="badge badge-overdue">overdue</span>;
  }
  return <span class={`badge badge-${invoice.status}`}>{invoice.status}</span>;
}

export const INVOICE_FILTERS = ['all', 'draft', 'open', 'overdue', 'paid', 'void'] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

export function matchesFilter(inv: InvoiceWithClient, filter: InvoiceFilter, today?: string): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'open':
      return inv.status === 'sent'; // includes overdue
    case 'overdue':
      return isOverdue(inv, today);
    default:
      return inv.status === filter;
  }
}

const FILTER_LABELS: Record<InvoiceFilter, string> = {
  all: 'All',
  draft: 'Draft',
  open: 'Open',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

const EMPTY_MESSAGES: Record<InvoiceFilter, string> = {
  all: 'No invoices yet.',
  draft: 'No draft invoices.',
  open: 'No open invoices — everything is settled.',
  overdue: 'Nothing overdue. 🎉',
  paid: 'No paid invoices yet.',
  void: 'No voided invoices.',
};

export function DashboardPage({
  invoices,
  filter,
  clientId,
  today,
  warnings,
  deleted,
  paid,
  emailed,
  emailError,
  emailEnabled,
  currentPath,
  nonce,
}: {
  invoices: InvoiceWithClient[];
  filter: InvoiceFilter;
  /** When set, only this client's invoices are shown (tab counts follow). */
  clientId?: number;
  today: string;
  warnings?: string[];
  /** Invoice number just deleted — success banner. */
  deleted?: string;
  /** Invoice number just marked paid from the row menu. */
  paid?: string;
  /** Recipient of an invoice email sent from the row menu. */
  emailed?: string;
  /** Delivery error surfaced without leaving the invoice list. */
  emailError?: string;
  emailEnabled: boolean;
  currentPath: string;
  nonce?: string;
}) {
  // Client dropdown options come from the invoices themselves — clients
  // without invoices would be dead filters anyway.
  const clientOptions = [...new Map(invoices.map((i) => [i.client_id, i.client_name])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const scoped = clientId ? invoices.filter((inv) => inv.client_id === clientId) : invoices;

  const visible = scoped.filter((inv) => matchesFilter(inv, filter, today));
  const counts = Object.fromEntries(
    INVOICE_FILTERS.map((f) => [f, scoped.filter((inv) => matchesFilter(inv, f, today)).length])
  ) as Record<InvoiceFilter, number>;

  const tabHref = (f: InvoiceFilter) => {
    const params = new URLSearchParams();
    if (f !== 'all') params.set('status', f);
    if (clientId) params.set('client', String(clientId));
    const qs = params.toString();
    return qs ? `/admin?${qs}` : '/admin';
  };
  const returnTo = tabHref(filter);

  return (
    <Layout title="Invoices" currentPath={currentPath} nonce={nonce}>
      <div class="page-head">
        <h1 class="page-title">Invoices</h1>
        <div class="actions">
          <a class="btn btn-primary" href="/admin/invoices/new">
            <Icon name="plus" />
            New invoice
          </a>
        </div>
      </div>

      {deleted ? <div class="banner banner-success">Invoice {deleted} deleted.</div> : null}
      {paid ? <div class="banner banner-success">Invoice {paid} marked as paid.</div> : null}
      {emailed ? <div class="banner banner-success">Invoice emailed to {emailed}.</div> : null}
      {emailError ? <div class="banner banner-error">Email failed to send: {emailError}</div> : null}

      {warnings?.length ? (
        <div class="banner banner-warning">
          <strong>Configuration warnings</strong>
          <ul class="warning-list">
            {warnings.map((w) => (
              <li>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div class="filter-bar">
        <nav class="filter-tabs">
          {INVOICE_FILTERS.map((f) => {
            // Hide noise: skip empty overdue/void tabs unless active
            if (counts[f] === 0 && f !== 'all' && f !== filter) return null;
            return (
              <a href={tabHref(f)} class={filter === f ? 'active' : ''}>
                {FILTER_LABELS[f]}
                <span class="filter-count">{counts[f]}</span>
              </a>
            );
          })}
        </nav>
        {clientOptions.length > 1 ? (
          <form method="get" action="/admin" class="client-filter">
            {filter !== 'all' ? <input type="hidden" name="status" value={filter} /> : null}
            <select name="client" aria-label="Filter by client" data-submit-on-change>
              <option value="">All clients</option>
              {clientOptions.map((cl) => (
                <option value={String(cl.id)} selected={cl.id === clientId}>
                  {cl.name}
                </option>
              ))}
            </select>
          </form>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <div class="empty-state">
          <p>{clientId ? 'No matching invoices for this client.' : EMPTY_MESSAGES[filter]}</p>
        </div>
      ) : (
        <table class="table table--stack">
          <thead>
            <tr>
              <th>Number</th>
              <th>Client</th>
              <th>Issue date</th>
              <th>Due date</th>
              <th>Status</th>
              <th class="text-right">Total</th>
              <th>
                <span class="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((inv) => (
              <tr data-href={`/admin/invoices/${inv.id}`}>
                <td data-label="Number">
                  <a href={`/admin/invoices/${inv.id}`}>{inv.number}</a>
                  {inv.subject ? <span class="row-subject muted">{inv.subject}</span> : null}
                </td>
                <td data-label="Client">{inv.client_name}</td>
                <td data-label="Issued">{formatDateHuman(inv.issue_date)}</td>
                <td data-label="Due">
                  {inv.due_date ? formatDateHuman(inv.due_date) : <span class="muted">—</span>}
                </td>
                <td data-label="Status">
                  <StatusBadge invoice={inv} today={today} />
                </td>
                <td class="text-right" data-label="Total">
                  {formatCents(inv.total_cents, inv.currency)}
                </td>
                <td class="row-actions">
                  <details class="row-menu">
                    <summary aria-label={`Actions for ${inv.number}`}>
                      <Icon name="kebab" />
                    </summary>
                    <div class="row-menu-panel">
                      <a href={`/admin/invoices/${inv.id}`}>
                        <Icon name="eye" />
                        View
                      </a>
                      <a href={`/admin/invoices/${inv.id}/edit`}>
                        <Icon name="pencil" />
                        Edit
                      </a>
                      <form method="post" action={`/admin/invoices/${inv.id}/duplicate`}>
                        <button type="submit" title="Copy this invoice into a new draft dated today">
                          <Icon name="duplicate" />
                          Duplicate
                        </button>
                      </form>
                      {emailEnabled && inv.client_email && (inv.status === 'draft' || inv.status === 'sent') ? (
                        <form
                          method="post"
                          action={`/admin/invoices/${inv.id}/status`}
                          data-confirm={`Email invoice ${inv.number} with its PDF attachment to ${inv.client_email}?${
                            inv.status === 'draft' ? ' It will be marked as sent.' : ''
                          }`}
                        >
                          <input type="hidden" name="action" value="send" />
                          <input type="hidden" name="email" value="1" />
                          <input type="hidden" name="return_to" value={returnTo} />
                          <button type="submit">
                            <Icon name="send" />
                            {inv.status === 'draft' ? 'Send invoice' : 'Resend invoice'}
                          </button>
                        </form>
                      ) : null}
                      {inv.status === 'draft' || inv.status === 'sent' ? (
                        <form method="post" action={`/admin/invoices/${inv.id}/status`}>
                          <input type="hidden" name="action" value="mark_paid" />
                          <input type="hidden" name="return_to" value={returnTo} />
                          <button type="submit">
                            <Icon name="check-circle" />
                            Mark as paid
                          </button>
                        </form>
                      ) : null}
                      <div class="row-menu-sep"></div>
                      <form
                        method="post"
                        action={`/admin/invoices/${inv.id}/status`}
                        data-confirm={deleteConfirm(inv)}
                      >
                        <input type="hidden" name="action" value="delete" />
                        <button type="submit" class="danger">
                          <Icon name="trash" />
                          Delete
                        </button>
                      </form>
                    </div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <script
        nonce={nonce}
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  document.querySelectorAll('tr[data-href]').forEach(function (row) {
    row.addEventListener('click', function (e) {
      // Let real links, buttons, menus, and text selection behave normally
      if (e.target.closest('a, button, input, form, details, summary')) return;
      if (window.getSelection().toString()) return;
      var href = row.getAttribute('data-href');
      if (e.metaKey || e.ctrlKey) window.open(href, '_blank');
      else location.href = href;
    });
  });

  // Row menus: only one open at a time, and clicking elsewhere closes them
  document.querySelectorAll('details.row-menu').forEach(function (menu) {
    menu.addEventListener('toggle', function () {
      if (!menu.open) return;
      document.querySelectorAll('details.row-menu[open]').forEach(function (other) {
        if (other !== menu) other.removeAttribute('open');
      });
    });
  });

  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.row-menu[open]').forEach(function (menu) {
      if (!menu.contains(e.target)) menu.removeAttribute('open');
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('details.row-menu[open]').forEach(function (menu) {
      menu.removeAttribute('open');
    });
  });
})();
`,
        }}
      ></script>
    </Layout>
  );
}
