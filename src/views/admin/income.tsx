import type { Branch, IncomeAttachmentMeta, IncomeListRow } from '../../db/queries';
import { formatDateHuman } from '../../lib/dates';
import { MAX_EXPENSE_ATTACHMENT_BYTES } from '../../lib/expenses';
import { GOLD_CURRENCY, MAX_GOLD_OUNCES, goldAmountToOunces } from '../../lib/gold';
import { currencyOptions, formatCents } from '../../lib/money';
import { Icon } from '../icons';
import { Layout } from '../layout';
import { EvidenceLink, EvidenceViewer, incomeEvidenceFile } from './evidence-viewer';

export type IncomeFormValues = {
  branch_id: string;
  payer: string;
  amount: string;
  /** Filled in place of an amount when the income is gold. */
  gold_ounces: string;
  currency: string;
  income_date: string;
  reference: string;
};

/** Money received outside invoicing, entered here or from the Telegram bots, with its files. */
export function IncomePage({
  income,
  attachments,
  branches,
  branchId,
  payers,
  goldBranchName = null,
  values,
  error,
  saved,
  nonce,
}: {
  /** The company that can receive gold, when it is in this workspace. */
  goldBranchName?: string | null;
  income: IncomeListRow[];
  attachments: IncomeAttachmentMeta[];
  branches: Branch[];
  branchId: number | null;
  /** Client names offered while typing who paid. */
  payers: string[];
  values: IncomeFormValues;
  error?: string;
  saved?: boolean;
  nonce?: string;
}) {
  const attachmentsByIncome = new Map<number, IncomeAttachmentMeta[]>();
  for (const attachment of attachments) {
    const list = attachmentsByIncome.get(attachment.income_id) ?? [];
    list.push(attachment);
    attachmentsByIncome.set(attachment.income_id, list);
  }
  return (
    <Layout title="Income" currentPath="/admin/income" nonce={nonce}>
      <div class="page-head">
        <div>
          <h1 class="page-title">Income</h1>
          <p class="muted">Money received without an invoice from this app, such as rent, and its supporting files.</p>
        </div>
        {branches.length > 1 ? (
          <div class="actions">
            <form method="get" action="/admin/income" class="client-filter">
              <select name="company" aria-label="Filter by company" data-submit-on-change>
                <option value="">All companies</option>
                {branches.map((branch) => (
                  <option value={String(branch.id)} selected={branch.id === branchId}>{branch.name}</option>
                ))}
              </select>
            </form>
          </div>
        ) : null}
      </div>

      {saved ? <div class="banner banner-success">Income saved.</div> : null}
      {error ? <div class="banner banner-error">{error}</div> : null}

      <div class="card">
        <h2>Add income</h2>
        <form method="post" action="/admin/income" enctype="multipart/form-data">
          <div class="form-row">
            <div class="form-group">
              <label for="income_branch">Company</label>
              <select id="income_branch" name="branch_id" required>
                {branches.map((branch) => (
                  <option value={String(branch.id)} selected={String(branch.id) === values.branch_id}>{branch.name}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label for="income_payer">Received from</label>
              <input id="income_payer" name="payer" value={values.payer} list="income-payers" minlength={2} maxlength={120} required placeholder="Client, tenant, or other payer" />
              <datalist id="income-payers">
                {payers.map((payer) => <option value={payer} />)}
              </datalist>
            </div>
            <div class="form-group">
              <label for="income_date">Date received</label>
              <input id="income_date" name="income_date" type="date" value={values.income_date} required />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="income_amount">Amount received</label>
              <input id="income_amount" name="amount" inputmode="decimal" value={values.amount} required={!goldBranchName} placeholder="0.00" />
            </div>
            {goldBranchName ? (
              <div class="form-group">
                <label for="income_gold">Or gold ounces</label>
                <input id="income_gold" name="gold_ounces" type="number" min="1" max={MAX_GOLD_OUNCES} step="1" value={values.gold_ounces} />
                <span class="muted">For gold received by {goldBranchName}. Leave the amount empty; gold has no price.</span>
              </div>
            ) : null}
            <div class="form-group">
              <label for="income_currency">Currency</label>
              <select id="income_currency" name="currency" required>
                {currencyOptions().map((currency) => (
                  <option value={currency.code} selected={currency.code === values.currency}>{currency.code} — {currency.name}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label for="income_reference">Reference or note <span class="muted">(optional)</span></label>
              <input id="income_reference" name="reference" value={values.reference} maxlength={300} />
            </div>
          </div>

          <div class="form-group">
            <label for="income_evidence">Invoice or receipt <span class="muted">(optional)</span></label>
            <input id="income_evidence" name="evidence" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp" />
            <span class="muted">PDF, JPG, PNG, or WebP · up to {MAX_EXPENSE_ATTACHMENT_BYTES / 1024 / 1024} MB. Income can be saved without a file.</span>
          </div>

          <div class="actions">
            <button type="submit" class="btn btn-primary">Add income</button>
          </div>
        </form>
      </div>

      {income.length === 0 ? (
        <div class="empty-state"><p>No income recorded in this workspace yet.</p></div>
      ) : (
        <table class="table table--stack expenses-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Received from</th>
              <th>Company</th>
              <th>Invoice</th>
              <th class="text-right">Amount</th>
              <th><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {income.map((entry) => (
              <tr class={entry.voided_at ? 'expense-voided' : undefined}>
                <td data-label="Date">{formatDateHuman(entry.income_date)}</td>
                <td data-label="Received from">
                  {entry.payer}
                  {entry.reference ? <span class="row-subject muted">{entry.reference}</span> : null}
                  {entry.voided_at ? <span class="badge badge-void">void</span> : null}
                </td>
                <td data-label="Company">{entry.branch_name}</td>
                <td data-label="Invoice">
                  <div class={`expense-evidence-cell ${entry.attachment_count ? '' : 'is-missing'}`} data-evidence-drop>
                    {entry.attachment_count ? (
                      (attachmentsByIncome.get(entry.id) ?? []).map((attachment, position) => (
                        <EvidenceLink
                          file={incomeEvidenceFile(entry.id, attachment)}
                          group={`income-${entry.id}`}
                          hidden={position > 0}
                          class="evidence-view-link"
                        >
                          <Icon name="eye" />
                          View {entry.attachment_count} file{entry.attachment_count === 1 ? '' : 's'}
                        </EvidenceLink>
                      ))
                    ) : <span class="badge badge-missing">No invoice</span>}
                    <form method="post" action={`/admin/income/${entry.id}/attachments`} enctype="multipart/form-data" class="quick-evidence-form">
                      <input
                        id={`quick-income-evidence-${entry.id}`}
                        name="evidence"
                        type="file"
                        required
                        data-auto-upload
                        accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp"
                      />
                      <label class="quick-evidence-action" for={`quick-income-evidence-${entry.id}`}>
                        <Icon name="upload" /> Upload invoice
                      </label>
                    </form>
                  </div>
                </td>
                <td class="text-right" data-label="Amount">
                  {entry.currency === GOLD_CURRENCY
                    ? `${goldAmountToOunces(entry.amount_cents)} oz gold`
                    : formatCents(entry.amount_cents, entry.currency)}
                </td>
                <td class="row-actions">
                  <details class="row-menu">
                    <summary aria-label={`Actions for ${entry.payer}`}><Icon name="kebab" /></summary>
                    <div class="row-menu-panel">
                      <form
                        method="post"
                        action={`/admin/income/${entry.id}/void`}
                        data-confirm={entry.voided_at
                          ? 'Restore this income to reports?'
                          : 'Void this income? It will stay on file but stop counting in reports.'}
                      >
                        <input type="hidden" name="action" value={entry.voided_at ? 'restore' : 'void'} />
                        <button type="submit" class={entry.voided_at ? undefined : 'danger'}>
                          <Icon name={entry.voided_at ? 'check-circle' : 'trash'} />
                          {entry.voided_at ? 'Restore' : 'Void'}
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
      {attachments.length ? <EvidenceViewer /> : null}
    </Layout>
  );
}
