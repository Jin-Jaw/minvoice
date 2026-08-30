import type { Branch, Client, ExpenseAttachmentMeta, ExpenseListRow } from '../../db/queries';
import { formatDateHuman } from '../../lib/dates';
import { EXPENSE_CATEGORIES, MAX_EXPENSE_ATTACHMENT_BYTES } from '../../lib/expenses';
import { currencyOptions, formatCents } from '../../lib/money';
import { Icon } from '../icons';
import { Layout } from '../layout';

export type ExpenseFormValues = {
  branch_id: string;
  client_id: string;
  expense_date: string;
  payee: string;
  category: string;
  description: string;
  reference: string;
  amount: string;
  tax_amount: string;
  currency: string;
};

export function ExpensesPage({
  expenses,
  branches,
  branchId,
  nonce,
}: {
  expenses: ExpenseListRow[];
  branches: Branch[];
  branchId: number | null;
  nonce?: string;
}) {
  return (
    <Layout title="Expenses" currentPath="/admin/expenses" nonce={nonce}>
      <div class="page-head">
        <div>
          <h1 class="page-title">Expenses</h1>
          <p class="muted">Paid supplier bills, employee costs, and their supporting evidence.</p>
        </div>
        <div class="actions">
          {branches.length > 1 ? (
            <form method="get" action="/admin/expenses" class="client-filter">
              <select name="company" aria-label="Filter by company" data-submit-on-change>
                <option value="">All companies</option>
                {branches.map((branch) => (
                  <option value={String(branch.id)} selected={branch.id === branchId}>{branch.name}</option>
                ))}
              </select>
            </form>
          ) : null}
          <a class="btn btn-secondary" href="/admin/expenses/import">
            <Icon name="upload" />
            Import invoice
          </a>
          <a class="btn btn-primary" href="/admin/expenses/new">
            <Icon name="plus" />
            New expense
          </a>
        </div>
      </div>

      {expenses.length === 0 ? (
        <div class="empty-state"><p>No expenses recorded yet.</p></div>
      ) : (
        <table class="table table--stack expenses-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Paid to</th>
              <th>Category</th>
              <th>Company</th>
              <th>Evidence</th>
              <th class="text-right">Amount</th>
              <th><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((expense) => (
              <tr class={expense.voided_at ? 'expense-voided' : undefined}>
                <td data-label="Date">{formatDateHuman(expense.expense_date)}</td>
                <td data-label="Paid to">
                  <a href={`/admin/expenses/${expense.id}`}>{expense.payee}</a>
                  {expense.description ? <span class="row-subject muted">{expense.description}</span> : null}
                  {expense.voided_at ? <span class="badge badge-void">void</span> : null}
                </td>
                <td data-label="Category">{expense.category}</td>
                <td data-label="Company">{expense.branch_name}</td>
                <td data-label="Evidence">
                  {expense.attachment_count ? (
                    <a href={`/admin/expenses/${expense.id}#evidence`}>
                      {expense.attachment_count} file{expense.attachment_count === 1 ? '' : 's'}
                    </a>
                  ) : <span class="muted">—</span>}
                </td>
                <td class="text-right" data-label="Amount">{formatCents(expense.amount_cents, expense.currency)}</td>
                <td class="row-actions">
                  <details class="row-menu">
                    <summary aria-label={`Actions for ${expense.payee}`}><Icon name="kebab" /></summary>
                    <div class="row-menu-panel">
                      <a href={`/admin/expenses/${expense.id}`}><Icon name="pencil" />Edit</a>
                      <form
                        method="post"
                        action={`/admin/expenses/${expense.id}/void`}
                        data-confirm={expense.voided_at
                          ? 'Restore this expense to reports?'
                          : 'Void this expense? It will stay on file but stop counting in reports.'}
                      >
                        <input type="hidden" name="action" value={expense.voided_at ? 'restore' : 'void'} />
                        <button type="submit" class={expense.voided_at ? undefined : 'danger'}>
                          <Icon name={expense.voided_at ? 'check-circle' : 'trash'} />
                          {expense.voided_at ? 'Restore' : 'Void'}
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
    </Layout>
  );
}

export function ExpenseInvoiceImportPage({ error, nonce }: { error?: string; nonce?: string }) {
  return (
    <Layout title="Import expense invoice" currentPath="/admin/expenses" nonce={nonce}>
      <div class="page-head">
        <div>
          <h1 class="page-title">Import expense invoice</h1>
          <p class="muted">Upload a supplier invoice and review the extracted details before it enters your reports.</p>
        </div>
      </div>

      {error ? <div class="banner banner-error">{error}</div> : null}

      <div class="card">
        <form method="post" action="/admin/expenses/import" enctype="multipart/form-data">
          <div class="form-group">
            <label for="expense_invoice_pdf">Supplier invoice PDF</label>
            <input id="expense_invoice_pdf" name="invoice" type="file" accept="application/pdf,.pdf" required />
            <span class="muted">
              Text-based PDF · up to {MAX_EXPENSE_ATTACHMENT_BYTES / 1024 / 1024} MB. The original is saved privately as expense evidence after confirmation.
            </span>
          </div>
          <div class="actions">
            <button type="submit" class="btn btn-primary"><Icon name="upload" />Extract details</button>
            <a class="btn btn-secondary" href="/admin/expenses">Cancel</a>
          </div>
        </form>
      </div>
    </Layout>
  );
}

export function ExpenseFormPage({
  expense,
  attachments = [],
  branches,
  clients,
  values,
  error,
  saved,
  duplicate,
  importReview,
  nonce,
}: {
  expense?: ExpenseListRow;
  attachments?: ExpenseAttachmentMeta[];
  branches: Branch[];
  clients: Client[];
  values: ExpenseFormValues;
  error?: string;
  saved?: boolean;
  duplicate?: boolean;
  importReview?: {
    token: string;
    filename: string;
    pageCount: number;
    warnings: string[];
  };
  nonce?: string;
}) {
  const editing = !!expense;
  const importing = !!importReview;
  const pageTitle = editing ? 'Edit expense' : importing ? 'Review imported expense' : 'New expense';
  return (
    <Layout title={editing ? `Edit ${expense.payee}` : importing ? 'Review imported expense' : 'New expense'} currentPath="/admin/expenses" nonce={nonce}>
      <div class="page-head">
        <div>
          <h1 class="page-title">{pageTitle}</h1>
          {editing ? <p class="muted">Recorded {formatDateHuman(expense.expense_date)} for {expense.branch_name}</p> : null}
          {importing ? <p class="muted">Check every field, then save the expense and its original PDF together.</p> : null}
        </div>
        {editing ? <span class={`badge ${expense.voided_at ? 'badge-void' : 'badge-paid'}`}>{expense.voided_at ? 'void' : 'recorded'}</span> : null}
      </div>

      {error ? <div class="banner banner-error">{error}</div> : null}
      {saved ? <div class="banner banner-success">Expense saved.</div> : null}
      {duplicate ? <div class="banner banner-warning">That exact file is already attached.</div> : null}
      {importReview ? (
        <div class={importReview.warnings.length ? 'banner banner-warning' : 'banner banner-success'}>
          <div>
            <strong>{importReview.warnings.length ? 'Review needed' : 'Details extracted'}</strong>
            <span> from <a href={`/admin/expenses/import/${importReview.token}/file`} target="_blank" rel="noopener">{importReview.filename}</a> ({importReview.pageCount} page{importReview.pageCount === 1 ? '' : 's'}).</span>
          </div>
          {importReview.warnings.length ? (
            <ul>{importReview.warnings.map((warning) => <li>{warning}</li>)}</ul>
          ) : <div>The original PDF will be retained privately as evidence.</div>}
        </div>
      ) : null}

      <div class="card">
        <form
          method="post"
          action={editing ? `/admin/expenses/${expense.id}` : importing ? `/admin/expenses/import/${importReview.token}/confirm` : '/admin/expenses'}
          enctype="multipart/form-data"
        >
          <div class="form-row">
            <div class="form-group">
              <label for="expense_branch">Company</label>
              <select id="expense_branch" name="branch_id" required>
                {branches.map((branch) => (
                  <option value={String(branch.id)} selected={String(branch.id) === values.branch_id}>{branch.name}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label for="expense_date">{importing ? 'Invoice / expense date' : 'Expense date'}</label>
              <input id="expense_date" name="expense_date" type="date" value={values.expense_date} required />
              {importing ? <span class="muted">Extracted from the supplier invoice. Change it if needed.</span> : null}
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="expense_payee">Paid to</label>
              <input id="expense_payee" name="payee" value={values.payee} maxlength={160} required placeholder="Supplier, employee, or contractor" />
            </div>
            <div class="form-group">
              <label for="expense_category">Category</label>
              <input id="expense_category" name="category" value={values.category} list="expense-categories" maxlength={80} required />
              <datalist id="expense-categories">
                {EXPENSE_CATEGORIES.map((category) => <option value={category} />)}
              </datalist>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="expense_amount">Total paid</label>
              <input id="expense_amount" name="amount" inputmode="decimal" value={values.amount} required placeholder="0.00" />
            </div>
            <div class="form-group">
              <label for="expense_tax">Tax included <span class="muted">(optional)</span></label>
              <input id="expense_tax" name="tax_amount" inputmode="decimal" value={values.tax_amount} placeholder="0.00" />
              <span class="muted">For records only; total paid drives cash-flow reports.</span>
            </div>
            <div class="form-group">
              <label for="expense_currency">Currency</label>
              <select id="expense_currency" name="currency" required>
                {currencyOptions().map((currency) => (
                  <option value={currency.code} selected={currency.code === values.currency}>{currency.code} — {currency.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="expense_client">Related client <span class="muted">(optional)</span></label>
              <select id="expense_client" name="client_id">
                <option value="">Company overhead / none</option>
                {clients.map((client) => (
                  <option value={String(client.id)} selected={String(client.id) === values.client_id}>{client.name}</option>
                ))}
              </select>
              <span class="muted">Assigning a client includes this cost in that client's filtered report.</span>
            </div>
            <div class="form-group">
              <label for="expense_reference">Supplier invoice or reference <span class="muted">(optional)</span></label>
              <input id="expense_reference" name="reference" value={values.reference} maxlength={120} />
            </div>
          </div>

          <div class="form-group">
            <label for="expense_description">Description or notes <span class="muted">(optional)</span></label>
            <textarea id="expense_description" name="description" maxlength={2000}>{values.description}</textarea>
          </div>

          {!editing && !importing ? (
            <div class="form-group">
              <label for="expense_evidence">Evidence <span class="muted">(optional)</span></label>
              <input id="expense_evidence" name="evidence" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp" />
              <span class="muted">PDF, JPG, PNG, or WebP · up to {MAX_EXPENSE_ATTACHMENT_BYTES / 1024 / 1024} MB. You can add more after saving.</span>
            </div>
          ) : null}

          <div class="actions">
            <button type="submit" class="btn btn-primary">{editing ? 'Save expense' : importing ? 'Save expense and PDF' : 'Record expense'}</button>
            {importing ? (
              <button type="submit" class="btn btn-secondary" formaction={`/admin/expenses/import/${importReview.token}/cancel`} formnovalidate>Cancel import</button>
            ) : <a class="btn btn-secondary" href="/admin/expenses">Cancel</a>}
          </div>
        </form>
      </div>

      {editing ? (
        <div class="card" id="evidence">
          <h2>Evidence</h2>
          <p class="muted">Private supporting files. Upload additional pages or documents one at a time.</p>
          {attachments.length ? (
            <div class="evidence-list">
              {attachments.map((attachment) => (
                <div class="evidence-row">
                  <div>
                    <a href={`/admin/expenses/${expense.id}/attachments/${attachment.id}`}>
                      <Icon name="download" /> {attachment.filename}
                    </a>
                    <span class="muted">{Math.ceil(attachment.size_bytes / 1024)} KB</span>
                  </div>
                  <form
                    method="post"
                    action={`/admin/expenses/${expense.id}/attachments/${attachment.id}/delete`}
                    data-confirm={`Remove ${attachment.filename}? This cannot be undone.`}
                  >
                    <button type="submit" class="btn btn-danger btn-sm">Remove</button>
                  </form>
                </div>
              ))}
            </div>
          ) : <p>No evidence attached yet.</p>}
          <form method="post" action={`/admin/expenses/${expense.id}/attachments`} enctype="multipart/form-data" class="evidence-upload">
            <div class="form-group">
              <label for="additional_evidence">Add evidence</label>
              <input id="additional_evidence" name="evidence" type="file" required accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp" />
              <span class="muted">PDF, JPG, PNG, or WebP · maximum 1.5 MB per file.</span>
            </div>
            <button type="submit" class="btn btn-secondary">Upload file</button>
          </form>
        </div>
      ) : null}
    </Layout>
  );
}
