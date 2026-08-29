import { Layout } from '../layout';
import { formatCents } from '../../lib/money';
import { formatTimestamp, todayInTz } from '../../lib/dates';
import type { InvoiceItem, InvoiceWithClient, Payment, TimelineEntry } from '../../db/queries';
import { StatusBadge } from './dashboard';
import { Icon } from '../icons';

/** Provider refs (Stripe session ids are 66 chars) get middle-truncated; full value on hover. */
export function ShortRef({ value }: { value: string }) {
  if (value.length <= 18) return <span class="ref">{value}</span>;
  return (
    <span class="ref" title={value}>
      {value.slice(0, 10)}…{value.slice(-4)}
    </span>
  );
}

export function InvoiceDetailPage({
  currentPath,
  invoice,
  items,
  payments,
  timeline,
  timezone,
  emailEnabled,
  hasOriginalPdf,
  notice,
  error,
  nonce,
}: {
  currentPath: string;
  invoice: InvoiceWithClient;
  items: InvoiceItem[];
  payments: Payment[];
  timeline: TimelineEntry[];
  timezone: string;
  /** false when Settings → Email = none: email actions degrade to mark-sent */
  emailEnabled: boolean;
  hasOriginalPdf: boolean;
  notice?: string;
  error?: string;
  nonce?: string;
}) {
  const canEdit = invoice.status === 'draft' || invoice.status === 'sent';
  const today = todayInTz(timezone);
  // Undone payments live in History only — the Payments card shows the books as they stand.
  const activePayments = payments.filter((p) => !p.undone_at);

  return (
    <Layout title={`Invoice ${invoice.number}`} currentPath={currentPath} nonce={nonce}>
      <div class="page-head">
        <h1 class="page-title">
          Invoice {invoice.number} <StatusBadge invoice={invoice} today={today} />
        </h1>
        <div class="actions">
          {emailEnabled && (invoice.status === 'draft' || invoice.status === 'sent') && invoice.client_email ? (
            <form
              method="post"
              action={`/admin/invoices/${invoice.id}/status`}
              data-confirm={`Email invoice ${invoice.number} with its PDF attachment to ${invoice.client_email}?${
                invoice.status === 'draft' ? ' It will be marked as sent.' : ''
              }`}
            >
              <input type="hidden" name="action" value="send" />
              <input type="hidden" name="email" value="1" />
              <button type="submit" class="btn btn-primary">
                <Icon name="send" />
                {invoice.status === 'draft' ? `Send & email to client` : 'Resend email'}
              </button>
            </form>
          ) : null}
          {invoice.status === 'draft' && (!invoice.client_email || !emailEnabled) ? (
            <form method="post" action={`/admin/invoices/${invoice.id}/status`}>
              <input type="hidden" name="action" value="send" />
              <button
                type="submit"
                class="btn btn-primary"
                title={
                  emailEnabled
                    ? 'The client has no email address — this only marks the invoice sent'
                    : 'Email sending is off (Settings) — this only marks the invoice sent'
                }
              >
                Mark sent (no email)
              </button>
            </form>
          ) : null}
          {canEdit ? (
            <a class="btn btn-secondary" href={`/admin/invoices/${invoice.id}/edit`}>
              Edit
            </a>
          ) : null}
          {invoice.status === 'sent' ? (
            <form
              method="post"
              action={`/admin/invoices/${invoice.id}/status`}
              data-confirm="Revert this invoice to draft? The sent date will be cleared."
            >
              <input type="hidden" name="action" value="unsend" />
              <button type="submit" class="btn btn-secondary">
                Unsend
              </button>
            </form>
          ) : null}
          {invoice.status === 'sent' ? (
            <form method="post" action={`/admin/invoices/${invoice.id}/status`}>
              <input type="hidden" name="action" value="void" />
              <button type="submit" class="btn btn-danger">
                Void
              </button>
            </form>
          ) : null}
          <form
            method="post"
            action={`/admin/invoices/${invoice.id}/status`}
            data-confirm={
              invoice.status === 'draft'
                ? 'Delete this draft invoice? This cannot be undone.'
                : invoice.status === 'paid'
                  ? `Delete PAID invoice ${invoice.number}? Its payment records are deleted too — reports and CSV exports will change — and nothing is refunded at Stripe/PayPal (refunds live in their dashboards). This cannot be undone.`
                  : `Delete invoice ${invoice.number}? Its client-facing record and history will be erased. This cannot be undone.`
            }
          >
            <input type="hidden" name="action" value="delete" />
            <button type="submit" class="btn btn-danger">
              Delete
            </button>
          </form>
          <form method="post" action={`/admin/invoices/${invoice.id}/duplicate`}>
            <button type="submit" class="btn btn-secondary" title="Copy this invoice into a new draft dated today">
              <Icon name="duplicate" />
              Duplicate
            </button>
          </form>
          {emailEnabled ? (
            <form method="post" action={`/admin/invoices/${invoice.id}/email-copy`}>
              <button
                type="submit"
                class="btn btn-secondary"
                title="Send this invoice email (with PDF) to your business address — the client is not contacted"
              >
                <Icon name="send" />
                Email me a copy
              </button>
            </form>
          ) : null}
          <a
            class="btn btn-secondary"
            href={`/admin/invoices/${invoice.id}/print?auto=1`}
            target="_blank"
            rel="noopener"
          >
            <Icon name="printer" />
            Print
          </a>
          <a class="btn btn-secondary" href={`/admin/invoices/${invoice.id}/pdf`}>
            <Icon name="download" />
            {hasOriginalPdf ? 'Download original PDF' : 'Download PDF'}
          </a>
        </div>
      </div>

      {invoice.subject ? <p class="invoice-subject muted">{invoice.subject}</p> : null}

      {notice ? <div class="banner banner-success">{notice}</div> : null}
      {error ? <div class="banner banner-error">{error}</div> : null}

      <div class="card">
        <h2>Original PDF</h2>
        {hasOriginalPdf ? (
          <p class="muted">The exact originally issued PDF is archived and used for downloads and invoice emails.</p>
        ) : (
          <form method="post" action={`/admin/invoices/${invoice.id}/source-pdf`} enctype="multipart/form-data">
            <div class="form-group">
              <label for="source_pdf">Archive the originally issued PDF</label>
              <input type="file" id="source_pdf" name="source_pdf" accept="application/pdf,.pdf" required />
              <span class="muted">Up to 750 KB. Once saved, downloads and emails use this exact document.</span>
            </div>
            <button type="submit" class="btn btn-secondary">Archive original PDF</button>
          </form>
        )}
      </div>

      <div class="card">
        <h2>Client</h2>
        <p>
          <a href={`/admin/clients/${invoice.client_id}`}>{invoice.client_name}</a>
        </p>
        {invoice.client_email ? <p class="muted">{invoice.client_email}</p> : null}
      </div>

      <div class="card">
        <dl class="invoice-meta">
          <div class="invoice-meta-row">
            <dt>Issue date</dt>
            <dd>{invoice.issue_date}</dd>
          </div>
          <div class="invoice-meta-row">
            <dt>Due date</dt>
            <dd>{invoice.due_date ?? '—'}</dd>
          </div>
          {invoice.status !== 'draft' ? (
            <div class="invoice-meta-row">
              <dt>Sent</dt>
              <dd>{invoice.sent_at ? invoice.sent_at.slice(0, 10) : '—'}</dd>
            </div>
          ) : null}
          {invoice.paid_at ? (
            <div class="invoice-meta-row">
              <dt>Paid</dt>
              <dd>{invoice.paid_at.slice(0, 10)}</dd>
            </div>
          ) : null}
        </dl>

        {invoice.status === 'draft' || invoice.status === 'sent' ? (
          <form method="post" action={`/admin/invoices/${invoice.id}/status`} class="sent-date-form">
            <input type="hidden" name="action" value="send" />
            <div class="form-row">
              <div class="form-group record-payment-date">
                <label for="sent-date">Sent date</label>
                <input
                  type="date"
                  id="sent-date"
                  name="sent_date"
                  value={invoice.sent_at?.slice(0, 10) ?? today}
                />
              </div>
              <button type="submit" class="btn btn-secondary record-payment-btn">
                {invoice.status === 'draft' ? 'Mark sent on this date' : 'Update sent date'}
              </button>
            </div>
          </form>
        ) : null}

        <table class="table table--stack">
          <thead>
            <tr>
              <th>Description</th>
              <th class="text-right">Quantity</th>
              <th class="text-right">Unit price</th>
              <th class="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr>
                <td data-label="Item" class="preline">
                  {item.description}
                </td>
                <td class="text-right item-dim" data-label="Quantity">
                  {item.quantity}
                </td>
                <td class="text-right item-dim" data-label="Unit price">
                  {formatCents(item.unit_price_cents, invoice.currency)}
                </td>
                <td class="text-right" data-label="Amount">
                  {formatCents(item.amount_cents, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div class="totals">
          <div class="totals-row">
            <span>Subtotal</span>
            <span>{formatCents(invoice.subtotal_cents, invoice.currency)}</span>
          </div>
          <div class="totals-row">
            <span>Tax</span>
            <span>{formatCents(invoice.tax_cents, invoice.currency)}</span>
          </div>
          <div class="totals-row total-final">
            <span>Total</span>
            <span>{formatCents(invoice.total_cents, invoice.currency)}</span>
          </div>
        </div>
      </div>

      {invoice.notes ? (
        <div class="card">
          <h2>Notes</h2>
          <p>{invoice.notes}</p>
        </div>
      ) : null}

      <div class="card">
        <h2>Payments</h2>
        {activePayments.length === 0 ? (
          <p class="muted">No payments recorded yet.</p>
        ) : (
          <table class="table table--stack">
            <thead>
              <tr>
                <th>Date</th>
                <th>Provider</th>
                <th>Reference</th>
                <th>Note</th>
                <th class="text-right">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activePayments.map((p) => (
                <tr>
                  <td data-label="Date">{formatTimestamp(p.created_at, timezone)}</td>
                  <td data-label="Provider">{p.provider}</td>
                  <td data-label="Reference">
                    {p.provider === 'stripe' && p.stripe_payment_intent && p.provider_ref ? (
                      <a
                        href={`https://dashboard.stripe.com/${
                          p.provider_ref.startsWith('cs_test_') ? 'test/' : ''
                        }payments/${p.stripe_payment_intent}`}
                        target="_blank"
                        rel="noopener"
                        title="Open in Stripe dashboard (refunds live there)"
                      >
                        <ShortRef value={p.provider_ref} />
                      </a>
                    ) : p.provider === 'paypal' && p.provider_ref ? (
                      <a
                        href={`https://www.paypal.com/activity/payment/${p.provider_ref}`}
                        target="_blank"
                        rel="noopener"
                        title="Open in PayPal activity (refunds live there)"
                      >
                        <ShortRef value={p.provider_ref} />
                      </a>
                    ) : p.provider_ref ? (
                      <ShortRef value={p.provider_ref} />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label="Note">
                    <form
                      method="post"
                      action={`/admin/invoices/${invoice.id}/payments/${p.id}/note`}
                      class="note-edit-form"
                    >
                      <input type="text" name="note" value={p.note ?? ''} placeholder="Add a note" />
                      <button type="submit" class="btn btn-secondary btn-sm">
                        Save
                      </button>
                    </form>
                  </td>
                  <td class="text-right" data-label="Amount">
                    {formatCents(p.amount_cents, p.currency)}
                  </td>
                  <td class="text-right">
                    <form
                      method="post"
                      action={`/admin/invoices/${invoice.id}/payments/${p.id}/undo`}
                      data-confirm={
                        p.provider === 'manual'
                          ? 'Undo this payment? The invoice will revert to unpaid.'
                          : 'Undo this payment? This only corrects the records here — it does NOT refund the charge at ' +
                            p.provider +
                            '.'
                      }
                    >
                      <button type="submit" class="btn btn-danger btn-sm">
                        Undo
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canEdit ? (
          <form method="post" action={`/admin/invoices/${invoice.id}/status`} class="record-payment">
            <input type="hidden" name="action" value="mark_paid" />
            <div class="form-row">
              <div class="form-group">
                <label for="payment-note">Payment note (optional)</label>
                <input
                  type="text"
                  id="payment-note"
                  name="note"
                  placeholder="e.g. Check #1042, wire ref, paid in cash"
                />
              </div>
              <div class="form-group record-payment-date">
                <label for="payment-date">Payment date</label>
                <input type="date" id="payment-date" name="payment_date" value={today} />
              </div>
              <button type="submit" class="btn btn-primary record-payment-btn">
                Record payment
              </button>
            </div>
            <p class="muted mt-1">
              Marks the invoice paid for the full amount ({formatCents(invoice.total_cents, invoice.currency)}).
            </p>
          </form>
        ) : null}
      </div>

      <div class="card">
        <h2>History</h2>
        <ol class="timeline">
          {timeline.map((t) => (
            <li class={`timeline-entry timeline-${t.kind}`}>
              <span class="timeline-when">{formatTimestamp(t.at, timezone)}</span>
              <span class="timeline-label">{t.label}</span>
              {t.detail ? <span class="muted"> — {t.detail}</span> : null}
              {t.kind === 'viewed' && t.eventId ? (
                <form
                  method="post"
                  action={`/admin/invoices/${invoice.id}/events/${t.eventId}/delete`}
                  class="timeline-remove"
                  data-confirm="Remove this view from the history?"
                >
                  <button type="submit" class="timeline-remove-btn" title="Remove this view" aria-label="Remove this view">
                    ×
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </Layout>
  );
}
