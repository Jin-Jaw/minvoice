// Telegram bot: conversational invoice, expense and income entry for a linked
// admin. Every action goes through the same queries/services as the web app.

import type { Bindings } from '../../env';
import {
  createClient,
  createExpenseFromInvoiceImport,
  createIncome,
  createInvoice,
  deleteExpenseInvoiceImport,
  getBranch,
  getClientForBranch,
  getInvoice,
  getInvoiceItems,
  getInvoiceSourcePdf,
  getLogo,
  getSettings,
  isOverdue,
  linkClientToBranch,
  listBranches,
  listClientsForBranch,
  listInvoices,
  logInvoiceEvent,
  markInvoiceSent,
  recordManualPayment,
  storeExpenseInvoiceImport,
} from '../../db/queries';
import { addDaysISO, formatDateHuman, todayInTz } from '../../lib/dates';
import { computeTotals, formatCents, isSupportedCurrency } from '../../lib/money';
import { EXPENSE_CATEGORIES, MAX_EXPENSE_ATTACHMENT_BYTES } from '../../lib/expenses';
import {
  detectExpenseBranch,
  extractExpenseInvoiceText,
  parseExpenseInvoice,
  type ParsedExpenseInvoice,
} from '../../lib/expense-invoice-import';
import { invoicePdfFilename } from '../../lib/invoice-filename';
import { parseLineItem, parseMoneyReply, type LineItemInput } from '../../lib/telegram-input';
import { generateInvoicePdf } from '../pdf';
import { sendInvoiceEmailToClientAndOwner } from '../email';
import { readReceiptImage, type ReceiptImageMime } from '../receipt-ocr';
import {
  TelegramApi,
  type InlineKeyboard,
  type TelegramCallbackQuery,
  type TelegramMessage,
} from './api';
import {
  addInvoiceAttachment,
  asEmailAttachments,
  claimUpdate,
  clearSession,
  consumeLinkToken,
  consumeRateLimit,
  getConnection,
  getSession,
  listInvoiceAttachments,
  saveSession,
  setConnectionBranch,
  sha256Hex,
  touchConnection,
} from './repository';

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type NewInvoiceState = {
  clientId: number;
  issueDate: string;
  /** Client (or company) payment terms, offered first for the due date. */
  termsDays: number;
  dueDate: string | null;
  currency: string;
  /** Client (or company) default rate, used when a line has no price. */
  defaultUnitPriceCents: number | null;
  /** The currency that default rate is in; it is not applied in any other. */
  defaultRateCurrency: string | null;
  items: LineItemInput[];
  subject?: string | null;
  notes?: string | null;
  /** Payment details already answered (or copied), so edits return to the summary. */
  notesChosen?: boolean;
  /** Number of the invoice this draft was copied from. */
  repeatedFrom?: string;
};

type IncomeState = {
  clientId?: number;
  clientName: string;
  currency?: string;
  amountCents?: number;
  incomeDate?: string;
  reference?: string | null;
};

type ExpenseState = {
  token?: string;
  parsed?: ParsedExpenseInvoice;
  kind?: 'pdf' | 'image';
  /** Company the expense is saved to (defaults to the active one). */
  targetBranchId?: number;
  /** targetBranchId came from the invoice's billed-to text. */
  branchDetected?: boolean;
  clientId?: number | null;
};

const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_LINE_ITEMS = 20;
const IMAGE_MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

const HELP = [
  '<b>Invoice bot</b>',
  '',
  '/newinvoice — create a draft',
  '/uploadinvoice — upload a supplier invoice or receipt photo',
  '/invoices — recent invoices',
  '/drafts — draft invoices',
  '/unpaid — sent and unpaid',
  '/overdue — overdue invoices',
  '/workspace — switch company/workspace',
  '/help — show this help',
].join('\n');

const EXPENSE_HELP = [
  '<b>Property / Flats expenses</b>',
  '',
  '/uploadinvoice — upload a supplier invoice PDF or receipt photo',
  '/income — add income received from a client',
  '/workspace — switch company/workspace',
  '/help — show this help',
].join('\n');

const LINE_ITEM_FORMAT =
  'Format: <b>description - price</b>, e.g.\n<code>Tech art support - 2500</code>\n<code>Shader work - 3 x 450</code>';

export async function handleTelegramUpdate(env: Bindings, update: TelegramUpdate): Promise<void> {
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN!);
  if (!(await claimUpdate(env.DB, update.update_id))) return;
  const callback = update.callback_query;
  const message = update.message ?? callback?.message;
  const user = update.message?.from ?? callback?.from;
  if (!message || !user) return;
  const userId = String(user.id);
  const chatId = String(message.chat.id);

  if (message.chat.type !== 'private') {
    if (update.message?.text?.startsWith('/start')) {
      await api.sendMessage(chatId, 'Open a private chat with this bot to connect your invoicing account.');
    }
    return;
  }
  if (!(await consumeRateLimit(env.DB, userId))) {
    await api.sendMessage(chatId, 'Please slow down for a moment and try again.');
    return;
  }

  try {
    if (update.message?.text?.startsWith('/start')) {
      const token = update.message.text.trim().split(/\s+/, 2)[1];
      if (token) {
        const linked = await consumeLinkToken(env.DB, token, userId, chatId, user.username);
        if (linked) {
          const linkedBranch = await getBranch(env.DB, linked.branch_id);
          await api.sendMessage(
            chatId,
            '✅ Telegram is connected to your invoicing account.',
            homeKeyboard(linkedBranch?.invoicing_enabled === 0)
          );
          return;
        }
        await api.sendMessage(
          chatId,
          '❌ That connection link is invalid or has expired. Create a new one in Settings → Telegram.'
        );
        return;
      }
    }

    const connection = await getConnection(env.DB, userId);
    if (!connection) {
      await api.sendMessage(chatId, 'Connect this Telegram account from the invoicing app first: Settings → Telegram.');
      return;
    }
    await touchConnection(env.DB, userId, chatId, user.username);
    const branch = await getBranch(env.DB, connection.branch_id);
    if (!branch) throw new Error('Your selected workspace is no longer available.');
    const expenseOnly = branch.invoicing_enabled === 0;
    const branchId = connection.branch_id;

    if (callback) {
      await api.answerCallbackQuery(callback.id);
      await handleCallback(env, api, branchId, userId, chatId, callback);
      return;
    }
    if (update.message?.document || update.message?.photo?.length) {
      await handleAttachment(env, api, branchId, userId, chatId, update.message);
      return;
    }

    const text = update.message?.text?.trim() ?? '';
    const command = text.split(/\s+/, 1)[0].toLowerCase().replace(/@[^\s]+$/, '');
    if (command.startsWith('/')) {
      await clearSession(env.DB, userId);
      if (command === '/start' || command === '/help') {
        await api.sendMessage(chatId, expenseOnly ? EXPENSE_HELP : HELP, homeKeyboard(expenseOnly));
        return;
      }
      if (command === '/newinvoice') return startNewInvoice(env, api, branchId, userId, chatId);
      if (command === '/uploadinvoice' || command === '/expense') {
        return startExpenseInvoiceUpload(env, api, branchId, userId, chatId);
      }
      if (command === '/income') return startAddIncome(env, api, branchId, userId, chatId);
      if (command === '/workspace' || command === '/workspaces') {
        return showWorkspaceList(env, api, branchId, chatId);
      }
      if (['/invoices', '/drafts', '/unpaid', '/overdue'].includes(command)) {
        if (expenseOnly) return explainExpenseOnly(api, chatId);
        return showInvoiceList(env, api, branchId, chatId, command.slice(1));
      }
      await api.sendMessage(chatId, 'I don’t know that command. Try /help.', homeKeyboard(expenseOnly));
      return;
    }

    const session = await getSession(env.DB, userId);
    if (session?.flow === 'create_invoice') {
      const state = JSON.parse(session.data_json) as NewInvoiceState;
      await continueNewInvoice(env, api, session.branch_id, userId, chatId, session.step, state, text);
      return;
    }
    if (session?.flow === 'add_income') {
      const state = JSON.parse(session.data_json) as IncomeState;
      await continueAddIncome(env, api, session.branch_id, userId, chatId, session.step, state, text);
      return;
    }
    if (session?.flow === 'expense_invoice' && ['amount', 'payee', 'date'].includes(session.step)) {
      const state = JSON.parse(session.data_json) as ExpenseState;
      await continueExpenseImport(env, api, session.branch_id, userId, chatId, session.step, state, text);
      return;
    }
    await api.sendMessage(chatId, expenseOnly ? EXPENSE_HELP : HELP, homeKeyboard(expenseOnly));
  } catch (error) {
    console.error(JSON.stringify({ event: 'telegram_update_failed', updateId: update.update_id, userId, error: String(error) }));
    await api.sendMessage(chatId, `❌ ${humanError(error)}`, homeKeyboard()).catch(() => undefined);
  }
}

function homeKeyboard(expenseOnly = false): InlineKeyboard {
  if (expenseOnly) {
    return [
      [{ text: '📥 Upload expense invoice', callback_data: 'expenseupload' }],
      [{ text: '💷 Add income from client', callback_data: 'income' }],
      [{ text: 'Switch workspace', callback_data: 'workspaces' }],
    ];
  }
  return [
    [
      { text: '➕ New invoice', callback_data: 'new' },
      { text: '📄 Invoices', callback_data: 'list:invoices' },
    ],
    [{ text: '📥 Upload expense invoice', callback_data: 'expenseupload' }],
    [
      { text: 'Unpaid', callback_data: 'list:unpaid' },
      { text: 'Overdue', callback_data: 'list:overdue' },
    ],
    [{ text: 'Switch workspace', callback_data: 'workspaces' }],
  ];
}

async function explainExpenseOnly(api: TelegramApi, chatId: string): Promise<void> {
  await api.sendMessage(
    chatId,
    'Property / Flats is expense-only. Upload a supplier invoice PDF or receipt photo instead of creating an outgoing invoice.',
    homeKeyboard(true)
  );
}

async function showWorkspaceList(env: Bindings, api: TelegramApi, currentBranchId: number, chatId: string): Promise<void> {
  const branches = await listBranches(env.DB);
  await api.sendMessage(chatId, '<b>Choose a workspace</b>\n\nAll invoice actions will use the selected workspace.', [
    ...branches.map((branch) => [
      {
        text: `${branch.id === currentBranchId ? '✓ ' : ''}${branch.name}`.slice(0, 60),
        callback_data: `workspace:${branch.id}`,
      },
    ]),
    [{ text: 'Cancel', callback_data: 'cancel' }],
  ]);
}

async function showInvoiceList(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  chatId: string,
  kind: string
): Promise<void> {
  const branch = await getBranch(env.DB, branchId);
  if (branch?.invoicing_enabled === 0) return explainExpenseOnly(api, chatId);
  const settings = await getSettings(env.DB, branchId);
  const today = todayInTz(settings.timezone);
  const all = await listInvoices(env.DB, branchId);
  const filtered = all
    .filter((invoice) => {
      if (kind === 'drafts') return invoice.status === 'draft';
      if (kind === 'unpaid') return invoice.status === 'sent';
      if (kind === 'overdue') return isOverdue(invoice, today);
      return true;
    })
    .slice(0, 10);
  const title = kind[0].toUpperCase() + kind.slice(1);
  if (!filtered.length) {
    await api.sendMessage(chatId, `<b>${title}</b>\n\nNothing to show.`, homeKeyboard());
    return;
  }
  const lines = filtered.map(
    (invoice) =>
      `${esc(invoice.number)} — ${esc(invoice.client_name)} — ${esc(formatCents(invoice.total_cents, invoice.currency))}`
  );
  const keyboard: InlineKeyboard = filtered.map((invoice) => [
    { text: `${invoice.number} · ${invoice.client_name}`.slice(0, 50), callback_data: `inv:${invoice.id}` },
  ]);
  keyboard.push([{ text: '➕ New invoice', callback_data: 'new' }]);
  await api.sendMessage(chatId, `<b>${title}</b>\n\n${lines.join('\n')}`, keyboard);
}

async function showInvoice(env: Bindings, api: TelegramApi, branchId: number, chatId: string, invoiceId: number): Promise<void> {
  const invoice = await getInvoice(env.DB, branchId, invoiceId);
  if (!invoice) throw new Error('Invoice not found in your company.');
  const attachments = await listInvoiceAttachments(env.DB, invoiceId);
  const due = invoice.due_date ? `\nDue: ${formatDateHuman(invoice.due_date)}` : '';
  const text = [
    `<b>${esc(invoice.number)}</b>`,
    esc(invoice.client_name),
    esc(formatCents(invoice.total_cents, invoice.currency)),
    `${due}\nStatus: ${esc(invoice.status)}`,
    attachments.length ? `Attachments: ${attachments.length}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const keyboard: InlineKeyboard = [
    [
      { text: 'View', url: `${env.APP_BASE_URL}/admin/invoices/${invoice.id}` },
      { text: 'PDF', callback_data: `pdf:${invoice.id}` },
    ],
    [
      { text: 'Attach files', callback_data: `attach:${invoice.id}` },
      { text: 'Send', callback_data: `sendask:${invoice.id}` },
    ],
  ];
  if (invoice.status === 'draft' || invoice.status === 'sent') {
    keyboard.push([{ text: 'Mark paid', callback_data: `paidask:${invoice.id}` }]);
  }
  await api.sendMessage(chatId, text, keyboard);
}

async function handleCallback(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  callback: TelegramCallbackQuery
): Promise<void> {
  const data = callback.data ?? '';
  const activeBranch = await getBranch(env.DB, branchId);
  if (data === 'new') return startNewInvoice(env, api, branchId, userId, chatId);
  if (data === 'expenseupload') return startExpenseInvoiceUpload(env, api, branchId, userId, chatId);
  if (data === 'income') return startAddIncome(env, api, branchId, userId, chatId);
  if (data === 'incomenew') return beginNewIncomeClient(env, api, branchId, userId, chatId);
  if (data === 'workspaces') return showWorkspaceList(env, api, branchId, chatId);
  if (data === 'cancel') {
    const session = await getSession(env.DB, userId);
    if (session?.flow === 'expense_invoice') {
      const token = (JSON.parse(session.data_json) as ExpenseState).token;
      if (token) await deleteExpenseInvoiceImport(env.DB, token);
    }
    await clearSession(env.DB, userId);
    await api.sendMessage(chatId, 'Cancelled.', homeKeyboard(activeBranch?.invoicing_enabled === 0));
    return;
  }
  if (data === 'attachdone') {
    await clearSession(env.DB, userId);
    await api.sendMessage(chatId, '✅ Attachments saved.', homeKeyboard());
    return;
  }
  if (data === 'itemsdone') return finishLineItems(env, api, branchId, userId, chatId);
  if (data === 'undoline') return undoLastLine(env, api, branchId, userId, chatId);
  if (data === 'addline' || data === 'rmmenu' || data === 'editdue' || data === 'editnotes') {
    return editDraftPart(env, api, branchId, userId, chatId, data);
  }
  if (data === 'rmkeep') return removeDraftLine(env, api, branchId, userId, chatId, null);
  if (data.startsWith('cur:')) return changeDraftCurrency(env, api, branchId, userId, chatId, data.slice(4));
  if (data.startsWith('due:')) return chooseDueDate(env, api, branchId, userId, chatId, data.slice(4));
  if (data.startsWith('expedit:')) return editExpenseField(env, api, branchId, userId, chatId, data.slice(8));
  if (data === 'expback') {
    const { state } = await loadExpenseSession(env, branchId, userId);
    return showExpenseReview(env, api, branchId, userId, chatId, state);
  }
  // Pickers whose value may be 0 ("today", "no client"), so they skip the id check below.
  const picked = data.match(/^(expday|expcat|expclient|expcompany):(\d{1,9})$/);
  if (picked) return setExpenseField(env, api, branchId, userId, chatId, picked[1], Number(picked[2]));
  if (data === 'notessaved') return choosePaymentDetails(env, api, branchId, userId, chatId, true);
  if (data === 'notesnone') return choosePaymentDetails(env, api, branchId, userId, chatId, false);
  if (data.startsWith('list:')) return showInvoiceList(env, api, branchId, chatId, data.slice(5));

  const [action, rawId] = data.split(':', 2);
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('That action is no longer valid.');

  if (action === 'workspace') {
    if (!(await setConnectionBranch(env.DB, userId, id))) throw new Error('That workspace is unavailable.');
    await clearSession(env.DB, userId);
    const selected = (await listBranches(env.DB)).find((branch) => branch.id === id);
    const expenseOnly = selected?.invoicing_enabled === 0;
    const detail = expenseOnly
      ? '\n\nThis workspace records uploaded expenses and direct client income. Outgoing invoice creation is disabled.'
      : '';
    await api.sendMessage(
      chatId,
      `✅ Active workspace: <b>${esc(selected?.name ?? 'Workspace')}</b>${detail}`,
      homeKeyboard(expenseOnly)
    );
    return;
  }
  if (action === 'expenseconfirm') return confirmExpenseImport(env, api, branchId, userId, chatId);
  if (action === 'expenseamount') return askExpenseAmount(env, api, branchId, userId, chatId);
  if (action === 'incomeclient') return selectIncomeClient(env, api, branchId, userId, chatId, id);
  if (action === 'incomeconfirm') return confirmIncome(env, api, branchId, userId, chatId);
  if (activeBranch?.invoicing_enabled === 0) return explainExpenseOnly(api, chatId);
  if (action === 'inv') return showInvoice(env, api, branchId, chatId, id);
  if (action === 'client') return selectClient(env, api, branchId, userId, chatId, id);
  if (action === 'create') return confirmCreate(env, api, branchId, userId, chatId);
  if (action === 'repeat') return repeatInvoice(env, api, branchId, userId, chatId, id);
  if (action === 'rmline') return removeDraftLine(env, api, branchId, userId, chatId, id);
  // Older drafts' "Edit" button: return to the line list without clearing it.
  if (action === 'editdraft') return editDraftPart(env, api, branchId, userId, chatId, 'addline');

  const invoice = await getInvoice(env.DB, branchId, id);
  if (!invoice) throw new Error('Invoice not found in your company.');

  if (action === 'pdf') {
    const [items, settings, source, logo] = await Promise.all([
      getInvoiceItems(env.DB, id),
      getSettings(env.DB, branchId),
      getInvoiceSourcePdf(env.DB, id),
      getLogo(env.DB, branchId),
    ]);
    const pdf = source?.bytes ?? (await generateInvoicePdf(invoice, items, settings, env.ASSETS, logo));
    await api.sendDocument(chatId, pdf, source?.filename ?? invoicePdfFilename(branchId, invoice.issue_date), invoice.number);
    return;
  }
  if (action === 'attach') {
    await saveSession(env.DB, userId, branchId, 'attach_invoice', 'files', { invoiceId: id });
    await api.sendMessage(chatId, `Send JPG, PNG, or PDF files for <b>${esc(invoice.number)}</b> (max 1 MB each).`, [
      [
        { text: 'Done', callback_data: 'attachdone' },
        { text: 'Cancel', callback_data: 'cancel' },
      ],
    ]);
    return;
  }
  if (action === 'sendask') {
    if (!invoice.client_email) throw new Error(`${invoice.number} cannot be sent because the client has no email address.`);
    const attachments = await listInvoiceAttachments(env.DB, id);
    await api.sendMessage(
      chatId,
      `<b>Send ${esc(invoice.number)}?</b>\n\nClient: ${esc(invoice.client_name)}\nEmail: ${esc(
        invoice.client_email
      )}\nAttachments: Invoice PDF${attachments.map((a) => `\n• ${esc(a.filename)}`).join('')}`,
      [
        [
          { text: 'Send invoice', callback_data: `send:${id}` },
          { text: 'Cancel', callback_data: 'cancel' },
        ],
      ]
    );
    return;
  }
  if (action === 'send') {
    if (!invoice.client_email) throw new Error('The client does not have an email address.');
    const [items, settings, source, logo, attachments] = await Promise.all([
      getInvoiceItems(env.DB, id),
      getSettings(env.DB, branchId),
      getInvoiceSourcePdf(env.DB, id),
      getLogo(env.DB, branchId),
      listInvoiceAttachments(env.DB, id),
    ]);
    const pdf = source?.bytes ?? (await generateInvoicePdf(invoice, items, settings, env.ASSETS, logo));
    await sendInvoiceEmailToClientAndOwner(env, invoice, settings, pdf, !!logo, asEmailAttachments(attachments));
    if (invoice.status === 'draft') {
      await markInvoiceSent(env.DB, id);
      await logInvoiceEvent(env.DB, id, 'sent');
    }
    await logInvoiceEvent(env.DB, id, 'emailed', `Triggered from Telegram; sent to ${invoice.client_email}`);
    await api.sendMessage(
      chatId,
      `✅ <b>${esc(invoice.number)}</b> sent successfully.\n\nRecipient: ${esc(invoice.client_email)}`,
      homeKeyboard()
    );
    return;
  }
  if (action === 'paidask') {
    await api.sendMessage(
      chatId,
      `Mark <b>${esc(invoice.number)}</b> as paid?\n\nAmount: ${esc(formatCents(invoice.total_cents, invoice.currency))}`,
      [
        [
          { text: 'Confirm', callback_data: `paid:${id}` },
          { text: 'Cancel', callback_data: 'cancel' },
        ],
      ]
    );
    return;
  }
  if (action === 'paid') {
    if (invoice.status !== 'draft' && invoice.status !== 'sent') throw new Error('Only draft or sent invoices can be marked paid.');
    await recordManualPayment(env.DB, invoice, { note: 'Marked paid from Telegram' });
    await logInvoiceEvent(env.DB, id, 'payment_note_edited', 'Marked paid from Telegram');
    await api.sendMessage(chatId, `✅ <b>${esc(invoice.number)}</b> marked paid.`, homeKeyboard());
  }
}

// ---------- New invoice ----------

const QUICK_CURRENCIES = ['GBP', 'EUR', 'USD'];

async function startNewInvoice(env: Bindings, api: TelegramApi, branchId: number, userId: string, chatId: string): Promise<void> {
  const branch = await getBranch(env.DB, branchId);
  if (!branch) throw new Error('That workspace is unavailable.');
  if (branch.invoicing_enabled === 0) return startExpenseInvoiceUpload(env, api, branchId, userId, chatId);
  const clients = (await listClientsForBranch(env.DB, branchId)).slice(0, 30);
  if (!clients.length) throw new Error('Create a client in the invoicing app before making an invoice.');
  await saveSession(env.DB, userId, branchId, 'create_invoice', 'client', {});
  await api.sendMessage(chatId, '<b>Select a client</b>', [
    ...clients.map((client) => [{ text: client.name.slice(0, 50), callback_data: `client:${client.id}` }]),
    [{ text: 'Cancel', callback_data: 'cancel' }],
  ]);
}

async function loadDraft(env: Bindings, branchId: number, userId: string, steps?: string[]) {
  const session = await getSession(env.DB, userId);
  if (!session || session.branch_id !== branchId || session.flow !== 'create_invoice' || (steps && !steps.includes(session.step))) {
    throw new Error('That draft expired. Start again with /newinvoice.');
  }
  return { step: session.step, state: JSON.parse(session.data_json) as NewInvoiceState };
}

async function selectClient(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  clientId: number
): Promise<void> {
  const session = await getSession(env.DB, userId);
  const client = await getClientForBranch(env.DB, clientId, branchId);
  if (!session || session.branch_id !== branchId || session.step !== 'client' || !client || client.archived) {
    throw new Error('That client is unavailable.');
  }
  const settings = await getSettings(env.DB, branchId);
  const issueDate = todayInTz(settings.timezone);
  const terms = client.payment_terms_days ?? settings.payment_terms_days;
  // A default rate is only meaningful in the currency it was set in.
  const clientRate = client.default_rate_cents ?? null;
  const state: NewInvoiceState = {
    clientId,
    issueDate,
    termsDays: terms,
    dueDate: terms > 0 ? addDaysISO(issueDate, terms) : null,
    currency: client.default_currency ?? settings.currency,
    defaultUnitPriceCents: clientRate ?? settings.default_rate_cents ?? null,
    defaultRateCurrency: clientRate !== null ? (client.default_currency ?? settings.currency) : settings.currency,
    items: [],
  };
  const last = (await listInvoices(env.DB, branchId)).find(
    (invoice) => invoice.client_id === clientId && invoice.status !== 'void'
  );
  await saveSession(env.DB, userId, branchId, 'create_invoice', 'items', state);
  const keyboard: InlineKeyboard = [];
  if (last) {
    keyboard.push([
      {
        text: `🔁 Repeat ${last.number} (${formatCents(last.total_cents, last.currency)})`.slice(0, 60),
        callback_data: `repeat:${last.id}`,
      },
    ]);
  }
  keyboard.push(currencyRow(state.currency), [{ text: 'Cancel', callback_data: 'cancel' }]);
  await api.sendMessage(
    chatId,
    `Client: <b>${esc(client.name)}</b>\nCurrency: <b>${esc(state.currency)}</b> (tap to change)\n\nSend the first line item.\n${lineItemHint(state)}`,
    keyboard
  );
}

function currencyRow(current: string): InlineKeyboard[number] {
  const options = QUICK_CURRENCIES.includes(current) ? QUICK_CURRENCIES : [current, ...QUICK_CURRENCIES];
  return options.map((code) => ({ text: code === current ? `✓ ${code}` : code, callback_data: `cur:${code}` }));
}

function defaultRate(state: NewInvoiceState): number | null {
  return state.currency === state.defaultRateCurrency ? state.defaultUnitPriceCents : null;
}

function lineItemHint(state: NewInvoiceState): string {
  const rate = defaultRate(state);
  const fallback = rate ? `\nSend just a description to use the default rate (${esc(formatCents(rate, state.currency))}).` : '';
  return `${LINE_ITEM_FORMAT}${fallback}`;
}

function itemLines(items: LineItemInput[], currency: string): string {
  return items
    .map((item, i) => {
      const qty = item.quantity === 1 ? '' : `${item.quantity} × `;
      return `${i + 1}. ${esc(item.description)} — ${qty}${esc(formatCents(item.unit_price_cents, currency))}`;
    })
    .join('\n');
}

/** The line list shown while adding items, with the running subtotal. */
async function showItems(api: TelegramApi, chatId: string, state: NewInvoiceState, note = ''): Promise<void> {
  if (!state.items.length) {
    await api.sendMessage(
      chatId,
      `${note}Currency: <b>${esc(state.currency)}</b>\n\nSend the first line item.\n${lineItemHint(state)}`,
      [currencyRow(state.currency), [{ text: 'Cancel', callback_data: 'cancel' }]]
    );
    return;
  }
  const full = state.items.length >= MAX_LINE_ITEMS;
  const { subtotal_cents } = computeTotals(state.items, 0);
  await api.sendMessage(
    chatId,
    `${note}<b>Line items</b>\n${itemLines(state.items, state.currency)}\n\nSubtotal: <b>${esc(
      formatCents(subtotal_cents, state.currency)
    )}</b>\n\n${full ? 'That’s the maximum number of lines. Press Done.' : 'Send another line item, or press Done.'}`,
    [
      [
        { text: '✅ Done', callback_data: 'itemsdone' },
        { text: '↩️ Undo last', callback_data: 'undoline' },
      ],
      currencyRow(state.currency),
      [{ text: 'Cancel', callback_data: 'cancel' }],
    ]
  );
}

async function continueNewInvoice(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  step: string,
  state: NewInvoiceState,
  text: string
): Promise<void> {
  if (!text) throw new Error('Please send text for this step.');
  if (step === 'items') {
    if (state.items.length >= MAX_LINE_ITEMS) throw new Error('That’s the maximum number of lines. Press Done.');
    const item = parseLineItem(text, defaultRate(state));
    if (!item) throw new Error(`I couldn’t read that line item.\n\n${LINE_ITEM_FORMAT}`);
    if (item.unit_price_cents > 10_000_000_000) throw new Error('That price is too large.');
    state.items = [...state.items, item];
    await saveSession(env.DB, userId, branchId, 'create_invoice', 'items', state);
    await showItems(api, chatId, state);
    return;
  }
  if (step === 'due_date') {
    const answer = text.toLowerCase();
    if (answer === 'none') return setDueDate(env, api, branchId, userId, chatId, state, null);
    if (answer === 'default') return setDueDate(env, api, branchId, userId, chatId, state, state.dueDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
      throw new Error('Use a real date in YYYY-MM-DD format, or tap one of the buttons.');
    }
    if (text < state.issueDate) throw new Error('The due date can’t be before the invoice date.');
    return setDueDate(env, api, branchId, userId, chatId, state, text);
  }
  if (step === 'notes') {
    const answer = text.toLowerCase();
    if (answer === 'default' || answer === 'saved') {
      const saved = (await getSettings(env.DB, branchId)).default_payment_details.trim();
      return setPaymentDetails(env, api, branchId, userId, chatId, state, saved || null);
    }
    return setPaymentDetails(env, api, branchId, userId, chatId, state, answer === 'none' ? null : text.slice(0, 2000));
  }
  throw new Error('Use the buttons above, or /newinvoice to start again.');
}

async function changeDraftCurrency(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  code: string
): Promise<void> {
  const { state } = await loadDraft(env, branchId, userId, ['items']);
  const currency = code.toUpperCase();
  if (!isSupportedCurrency(currency)) throw new Error('That currency is not supported.');
  state.currency = currency;
  await saveSession(env.DB, userId, branchId, 'create_invoice', 'items', state);
  await showItems(api, chatId, state, `✅ Currency set to <b>${esc(currency)}</b>.\n\n`);
}

async function undoLastLine(env: Bindings, api: TelegramApi, branchId: number, userId: string, chatId: string): Promise<void> {
  const { state } = await loadDraft(env, branchId, userId, ['items']);
  const removed = state.items.pop();
  await saveSession(env.DB, userId, branchId, 'create_invoice', 'items', state);
  await showItems(api, chatId, state, removed ? `Removed “${esc(removed.description)}”.\n\n` : '');
}

async function finishLineItems(env: Bindings, api: TelegramApi, branchId: number, userId: string, chatId: string): Promise<void> {
  const { state } = await loadDraft(env, branchId, userId, ['items']);
  if (!state.items.length) throw new Error(`Add at least one line item first.\n\n${LINE_ITEM_FORMAT}`);
  // Coming back from the summary ("Add line") skips questions already answered.
  if (state.notesChosen) {
    await saveSession(env.DB, userId, branchId, 'create_invoice', 'confirm', state);
    return showDraftSummary(env, api, branchId, chatId, state);
  }
  await askDueDate(env, api, branchId, userId, chatId, state);
}

async function askDueDate(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  state: NewInvoiceState
): Promise<void> {
  await saveSession(env.DB, userId, branchId, 'create_invoice', 'due_date', state);
  const options = [...new Set([state.termsDays, 14, 30].filter((days) => days > 0))];
  await api.sendMessage(chatId, 'When is it due? Tap an option or send a date (YYYY-MM-DD).', [
    ...options.map((days) => [
      {
        text: `${days === state.termsDays ? '⭐ ' : ''}In ${days} days (${formatDateHuman(addDaysISO(state.issueDate, days))})`,
        callback_data: `due:${days}`,
      },
    ]),
    [{ text: 'No due date', callback_data: 'due:none' }],
  ]);
}

async function chooseDueDate(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  choice: string
): Promise<void> {
  const { state } = await loadDraft(env, branchId, userId, ['due_date']);
  if (choice === 'none') return setDueDate(env, api, branchId, userId, chatId, state, null);
  const days = Number(choice);
  if (!Number.isInteger(days) || days <= 0 || days > 365) throw new Error('That due date option is no longer valid.');
  await setDueDate(env, api, branchId, userId, chatId, state, addDaysISO(state.issueDate, days));
}

async function setDueDate(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  state: NewInvoiceState,
  dueDate: string | null
): Promise<void> {
  state.dueDate = dueDate;
  if (state.notesChosen) {
    await saveSession(env.DB, userId, branchId, 'create_invoice', 'confirm', state);
    return showDraftSummary(env, api, branchId, chatId, state);
  }
  await askPaymentDetails(env, api, branchId, userId, chatId, state);
}

/** Like the web form: new invoices start with the company's saved payment details. */
async function askPaymentDetails(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  state: NewInvoiceState
): Promise<void> {
  const settings = await getSettings(env.DB, branchId);
  const saved = settings.default_payment_details.trim();
  await saveSession(env.DB, userId, branchId, 'create_invoice', 'notes', state);
  if (!saved) {
    await api.sendMessage(chatId, 'Notes or payment details? Send text, or <b>none</b>.', [
      [{ text: 'No payment details', callback_data: 'notesnone' }],
    ]);
    return;
  }
  await api.sendMessage(
    chatId,
    `<b>Payment details</b>\n\nSaved for ${esc(settings.business_name || 'this company')}:\n<pre>${esc(
      saved.slice(0, 1500)
    )}</pre>\n\nUse these, or send different text for this invoice.`,
    [
      [{ text: '✅ Use saved details', callback_data: 'notessaved' }],
      [{ text: 'No payment details', callback_data: 'notesnone' }],
    ]
  );
}

async function setPaymentDetails(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  state: NewInvoiceState,
  notes: string | null
): Promise<void> {
  state.notes = notes;
  state.notesChosen = true;
  await saveSession(env.DB, userId, branchId, 'create_invoice', 'confirm', state);
  await showDraftSummary(env, api, branchId, chatId, state);
}

async function choosePaymentDetails(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  useSaved: boolean
): Promise<void> {
  const { state } = await loadDraft(env, branchId, userId, ['notes']);
  const saved = useSaved ? (await getSettings(env.DB, branchId)).default_payment_details.trim() : '';
  await setPaymentDetails(env, api, branchId, userId, chatId, state, saved || null);
}

/** Copy a previous invoice's lines, currency and payment details, dated today. */
async function repeatInvoice(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  invoiceId: number
): Promise<void> {
  const { state } = await loadDraft(env, branchId, userId, ['items']);
  const source = await getInvoice(env.DB, branchId, invoiceId);
  if (!source || source.client_id !== state.clientId) throw new Error('That invoice can’t be repeated for this client.');
  const items = await getInvoiceItems(env.DB, invoiceId);
  if (!items.length) throw new Error(`${source.number} has no line items to copy.`);
  state.items = items.slice(0, MAX_LINE_ITEMS).map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unit_price_cents: item.unit_price_cents,
  }));
  state.currency = source.currency;
  state.subject = source.subject;
  state.notes = source.notes;
  state.notesChosen = true;
  state.repeatedFrom = source.number;
  await saveSession(env.DB, userId, branchId, 'create_invoice', 'confirm', state);
  await showDraftSummary(env, api, branchId, chatId, state);
}

async function showDraftSummary(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  chatId: string,
  state: NewInvoiceState
): Promise<void> {
  const [client, settings] = await Promise.all([
    getClientForBranch(env.DB, state.clientId, branchId),
    getSettings(env.DB, branchId),
  ]);
  if (!client) throw new Error('The selected client no longer exists.');
  const totals = computeTotals(state.items, settings.tax_rate_bps);
  await api.sendMessage(
    chatId,
    [
      state.repeatedFrom ? `<b>Invoice draft</b> (copy of ${esc(state.repeatedFrom)})` : '<b>Invoice draft</b>',
      '',
      `Client: ${esc(client.name)}`,
      `Invoice date: ${formatDateHuman(state.issueDate)}`,
      `Due: ${state.dueDate ? formatDateHuman(state.dueDate) : 'None'}`,
      '',
      itemLines(state.items, state.currency),
      '',
      settings.tax_rate_bps
        ? `Tax: ${esc(formatCents(totals.tax_cents, state.currency))} (${(settings.tax_rate_bps / 100).toFixed(2)}%)`
        : 'Tax: none',
      `Total: <b>${esc(formatCents(totals.total_cents, state.currency))}</b>`,
      `Payment details: ${state.notes ? esc(firstLine(state.notes, 60)) : 'None'}`,
    ].join('\n'),
    [
      [{ text: '✅ Create invoice', callback_data: 'create:1' }],
      [
        { text: '➕ Add line', callback_data: 'addline' },
        { text: '➖ Remove line', callback_data: 'rmmenu' },
      ],
      [
        { text: '📅 Due date', callback_data: 'editdue' },
        { text: '💳 Payment details', callback_data: 'editnotes' },
      ],
      [{ text: 'Cancel', callback_data: 'cancel' }],
    ]
  );
}

type DraftEdit = 'addline' | 'rmmenu' | 'editdue' | 'editnotes';

async function editDraftPart(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  part: DraftEdit
): Promise<void> {
  const { state } = await loadDraft(env, branchId, userId, ['confirm']);
  if (part === 'addline') {
    await saveSession(env.DB, userId, branchId, 'create_invoice', 'items', state);
    return showItems(api, chatId, state);
  }
  if (part === 'editdue') return askDueDate(env, api, branchId, userId, chatId, state);
  if (part === 'editnotes') return askPaymentDetails(env, api, branchId, userId, chatId, state);
  await api.sendMessage(chatId, 'Which line should I remove?', [
    ...state.items.map((item, i) => [
      { text: `${i + 1}. ${item.description}`.slice(0, 60), callback_data: `rmline:${i + 1}` },
    ]),
    [{ text: 'Keep all', callback_data: 'rmkeep' }],
  ]);
}

async function removeDraftLine(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  position: number | null
): Promise<void> {
  const { state } = await loadDraft(env, branchId, userId, ['confirm']);
  if (position !== null) {
    if (position < 1 || position > state.items.length) throw new Error('That line no longer exists.');
    state.items.splice(position - 1, 1);
  }
  if (!state.items.length) {
    await saveSession(env.DB, userId, branchId, 'create_invoice', 'items', state);
    return showItems(api, chatId, state, 'All lines removed.\n\n');
  }
  await saveSession(env.DB, userId, branchId, 'create_invoice', 'confirm', state);
  await showDraftSummary(env, api, branchId, chatId, state);
}

async function confirmCreate(env: Bindings, api: TelegramApi, branchId: number, userId: string, chatId: string): Promise<void> {
  const { state } = await loadDraft(env, branchId, userId, ['confirm']);
  if (!state.items.length) throw new Error('That draft has no line items. Start again with /newinvoice.');
  const client = await getClientForBranch(env.DB, state.clientId, branchId);
  if (!client || client.archived) throw new Error('The selected client is unavailable.');
  const id = await createInvoice(env.DB, branchId, {
    client_id: state.clientId,
    issue_date: state.issueDate,
    due_date: state.dueDate ?? null,
    subject: (state.subject || state.items[0].description).slice(0, 160),
    notes: state.notes ?? null,
    currency: state.currency,
    items: state.items,
  });
  await logInvoiceEvent(env.DB, id, 'created_via_telegram', state.repeatedFrom ? `Repeated from ${state.repeatedFrom}` : undefined);
  await clearSession(env.DB, userId);
  await api.sendMessage(chatId, '✅ Invoice created');
  await showInvoice(env, api, branchId, chatId, id);
}

// ---------- Direct income (expense-only workspaces) ----------

async function startAddIncome(env: Bindings, api: TelegramApi, branchId: number, userId: string, chatId: string): Promise<void> {
  const branch = await getBranch(env.DB, branchId);
  if (!branch) throw new Error('That workspace is unavailable.');
  if (branch.invoicing_enabled !== 0) throw new Error('Direct client income is available in the Property / Flats workspace.');
  const clients = (await listClientsForBranch(env.DB, branchId)).slice(0, 30);
  await saveSession(env.DB, userId, branchId, 'add_income', 'client', {});
  if (!clients.length) return beginNewIncomeClient(env, api, branchId, userId, chatId);
  await api.sendMessage(chatId, '<b>Who paid you?</b>', [
    ...clients.map((client) => [{ text: client.name.slice(0, 50), callback_data: `incomeclient:${client.id}` }]),
    [{ text: '➕ New client', callback_data: 'incomenew' }],
    [{ text: 'Cancel', callback_data: 'cancel' }],
  ]);
}

async function beginNewIncomeClient(env: Bindings, api: TelegramApi, branchId: number, userId: string, chatId: string): Promise<void> {
  const session = await getSession(env.DB, userId);
  if (!session || session.branch_id !== branchId || session.flow !== 'add_income') throw new Error('Start again with /income.');
  await saveSession(env.DB, userId, branchId, 'add_income', 'new_client', {});
  await api.sendMessage(chatId, 'Send the client or tenant name.');
}

async function selectIncomeClient(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  clientId: number
): Promise<void> {
  const session = await getSession(env.DB, userId);
  const client = await getClientForBranch(env.DB, clientId, branchId);
  if (!session || session.branch_id !== branchId || session.flow !== 'add_income' || session.step !== 'client' || !client) {
    throw new Error('That client is unavailable.');
  }
  await askIncomeAmount(env, api, branchId, userId, chatId, { clientId, clientName: client.name });
}

async function askIncomeAmount(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  state: IncomeState
): Promise<void> {
  const settings = await getSettings(env.DB, branchId);
  state.currency = settings.currency;
  await saveSession(env.DB, userId, branchId, 'add_income', 'amount', state);
  await api.sendMessage(
    chatId,
    `Amount received from <b>${esc(state.clientName)}</b>?\n\nSend an amount in ${esc(
      settings.currency
    )}, or include another currency such as <b>1200 EUR</b>.`
  );
}

async function continueAddIncome(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  step: string,
  state: IncomeState,
  text: string
): Promise<void> {
  if (!text) throw new Error('Please send a value for this step.');
  if (step === 'new_client') {
    const name = text.trim();
    if (name.length < 2 || name.length > 120) throw new Error('Client name must be between 2 and 120 characters.');
    return askIncomeAmount(env, api, branchId, userId, chatId, { clientName: name });
  }
  if (step === 'amount') {
    const money = parseMoneyReply(text);
    if (!money) throw new Error('Enter a valid amount greater than zero, e.g. 1200 or 1200 EUR.');
    state.amountCents = money.cents;
    state.currency = money.currency ?? state.currency;
    const settings = await getSettings(env.DB, branchId);
    state.incomeDate = todayInTz(settings.timezone);
    await saveSession(env.DB, userId, branchId, 'add_income', 'date', state);
    await api.sendMessage(chatId, `Date received? Send YYYY-MM-DD or <b>today</b> (${state.incomeDate}).`);
    return;
  }
  if (step === 'date') {
    if (text.toLowerCase() !== 'today' && text.toLowerCase() !== 'default') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
        throw new Error('Use a real date in YYYY-MM-DD format.');
      }
      state.incomeDate = text;
    }
    await saveSession(env.DB, userId, branchId, 'add_income', 'reference', state);
    await api.sendMessage(chatId, 'Reference or note? Send text, or <b>none</b>.');
    return;
  }
  if (step === 'reference') {
    state.reference = text.toLowerCase() === 'none' ? null : text.slice(0, 300);
    await saveSession(env.DB, userId, branchId, 'add_income', 'confirm', state);
    await api.sendMessage(
      chatId,
      [
        '<b>Confirm income</b>',
        '',
        `From: ${esc(state.clientName)}`,
        `Amount: ${esc(formatCents(state.amountCents!, state.currency!))}`,
        `Date: ${esc(state.incomeDate!)}`,
        `Reference: ${esc(state.reference ?? 'None')}`,
      ].join('\n'),
      [[{ text: 'Save income', callback_data: 'incomeconfirm:1' }], [{ text: 'Cancel', callback_data: 'cancel' }]]
    );
  }
}

async function confirmIncome(env: Bindings, api: TelegramApi, branchId: number, userId: string, chatId: string): Promise<void> {
  const session = await getSession(env.DB, userId);
  if (!session || session.branch_id !== branchId || session.flow !== 'add_income' || session.step !== 'confirm') {
    throw new Error('That income entry expired. Start again with /income.');
  }
  const branch = await getBranch(env.DB, branchId);
  if (!branch || branch.invoicing_enabled !== 0) throw new Error('Direct income is unavailable in this workspace.');
  const state = JSON.parse(session.data_json) as IncomeState;
  if (!state.clientName || !state.amountCents || !state.currency || !state.incomeDate) {
    throw new Error('That income entry is incomplete.');
  }
  let clientId = state.clientId ?? null;
  if (!clientId) {
    const existing = (await listClientsForBranch(env.DB, branchId, true)).find(
      (client) => client.name.localeCompare(state.clientName, undefined, { sensitivity: 'accent' }) === 0
    );
    if (existing) clientId = existing.id;
    else {
      clientId = await createClient(env.DB, {
        name: state.clientName,
        email: null,
        address: null,
        default_rate_cents: null,
        payment_terms_days: null,
      }, branch.workspace_id);
      await linkClientToBranch(env.DB, clientId, branchId);
    }
  }
  const incomeId = await createIncome(env.DB, {
    branch_id: branchId,
    client_id: clientId,
    payer: state.clientName,
    income_date: state.incomeDate,
    amount_cents: state.amountCents,
    currency: state.currency,
    reference: state.reference ?? null,
  });
  await clearSession(env.DB, userId);
  await api.sendMessage(
    chatId,
    `✅ Income saved: <b>${esc(state.clientName)}</b> — ${esc(formatCents(state.amountCents, state.currency))}`,
    [[{ text: 'View reports', url: `${env.APP_BASE_URL}/admin/reports` }], ...homeKeyboard(true)]
  );
  console.log(JSON.stringify({ event: 'telegram_income_created', branchId, incomeId, userId }));
}

// ---------- Expense upload (PDF or receipt photo) ----------

async function startExpenseInvoiceUpload(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string
): Promise<void> {
  const branch = await getBranch(env.DB, branchId);
  if (!branch) throw new Error('That workspace is unavailable.');
  await saveSession(env.DB, userId, branchId, 'expense_invoice', 'file', {});
  await api.sendMessage(
    chatId,
    '<b>Upload a supplier invoice or receipt</b>\n\nSend a text-based PDF or a photo of the receipt (maximum 1.5 MB). I’ll read the supplier, date and total for you to confirm.',
    [[{ text: 'Cancel', callback_data: 'cancel' }]]
  );
}

/** The expense evidence to download: a PDF/image document, or the largest photo size under the limit. */
function expenseSource(message: TelegramMessage): { fileId: string; declaredMime: string; size?: number; name?: string } {
  const document = message.document;
  if (document) {
    const mime = document.mime_type ?? '';
    if (mime !== 'application/pdf' && !IMAGE_MIMES.includes(mime)) {
      throw new Error('Send the supplier invoice as a PDF, or a JPG, PNG or WebP photo of the receipt.');
    }
    return { fileId: document.file_id, declaredMime: mime, size: document.file_size, name: document.file_name };
  }
  const sizes = message.photo ?? [];
  const photo = [...sizes].reverse().find((size) => (size.file_size ?? 0) <= MAX_EXPENSE_ATTACHMENT_BYTES) ?? sizes[0];
  if (!photo) throw new Error('No file was found in that message.');
  return { fileId: photo.file_id, declaredMime: 'image/jpeg', size: photo.file_size };
}

async function handleExpenseInvoiceUpload(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  message: TelegramMessage
): Promise<void> {
  const source = expenseSource(message);
  if ((source.size ?? 0) > MAX_EXPENSE_ATTACHMENT_BYTES) throw new Error('That file is larger than the 1.5 MB limit.');
  const bytes = await api.downloadFile(source.fileId, MAX_EXPENSE_ATTACHMENT_BYTES);
  const mime = sniffMime(bytes);
  if (!mime || (mime === 'application/pdf') !== (source.declaredMime === 'application/pdf')) {
    throw new Error('The file contents are not a valid PDF, JPG, PNG or WebP.');
  }
  await api.sendChatAction(chatId, 'typing').catch(() => undefined);

  const settings = await getSettings(env.DB, branchId);
  let parsed: ParsedExpenseInvoice;
  let detectedBranch: number | null = null;
  if (mime === 'application/pdf') {
    const extraction = await extractExpenseInvoiceText(bytes);
    const branches = await listBranches(env.DB);
    parsed = parseExpenseInvoice(extraction.lines, branches.map((branch) => branch.name));
    // Supplier invoices name who they were billed to; file them under that company.
    detectedBranch = detectExpenseBranch(extraction.lines, branches);
  } else {
    parsed = await readReceiptImage(env.AI, bytes, mime as ReceiptImageMime);
  }
  if (!parsed.currency) parsed.currency = settings.currency;
  if (!parsed.expenseDate) parsed.expenseDate = todayInTz(settings.timezone);

  const token = newExpenseImportToken();
  const fallbackName = mime === 'application/pdf' ? `supplier-invoice-${message.message_id}` : `receipt-${message.message_id}`;
  await storeExpenseInvoiceImport(env.DB, token, {
    bytes,
    mime,
    filename: sanitizeFilename(source.name ?? fallbackName, mime),
    size_bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  });
  const state: ExpenseState = {
    token,
    parsed,
    kind: mime === 'application/pdf' ? 'pdf' : 'image',
    targetBranchId: detectedBranch ?? branchId,
    branchDetected: detectedBranch !== null && detectedBranch !== branchId,
    clientId: null,
  };

  if (parsed.amountCents === null) {
    await saveSession(env.DB, userId, branchId, 'expense_invoice', 'amount', state);
    await api.sendMessage(
      chatId,
      `${await expenseSummary(env, state)}\n\nI couldn’t read the total. Send the amount paid, e.g. <b>12.40</b> or <b>12.40 EUR</b>.`,
      [reviewInAppRow(env, token), [{ text: 'Cancel', callback_data: 'cancel' }]]
    );
    return;
  }
  await showExpenseReview(env, api, branchId, userId, chatId, state, 'Is the total right?');
}

function reviewInAppRow(env: Bindings, token: string): InlineKeyboard[number] {
  return [{ text: 'Review in app', url: `${env.APP_BASE_URL}/admin/expenses/import/${token}/review` }];
}

async function expenseSummary(env: Bindings, state: ExpenseState, heading = '<b>Expense found</b>'): Promise<string> {
  const parsed = state.parsed!;
  const [branch, client] = await Promise.all([
    getBranch(env.DB, state.targetBranchId!),
    state.clientId ? getClientForBranch(env.DB, state.clientId, state.targetBranchId!) : Promise.resolve(null),
  ]);
  const total =
    parsed.amountCents === null || !parsed.currency ? 'Needs review' : formatCents(parsed.amountCents, parsed.currency);
  const tax = parsed.taxCents === null || !parsed.currency ? 'Not detected' : formatCents(parsed.taxCents, parsed.currency);
  const warnings = parsed.warnings.length ? `\n\n${parsed.warnings.map((warning) => `⚠️ ${esc(warning)}`).join('\n')}` : '';
  return (
    [
      heading,
      '',
      `Supplier: ${esc(parsed.payee ?? 'Needs review')}`,
      `Date: ${esc(parsed.expenseDate ? formatDateHuman(parsed.expenseDate) : 'Today')}`,
      `Total: <b>${esc(total)}</b>`,
      `Tax: ${esc(tax)}`,
      `Reference: ${esc(parsed.reference ?? 'None detected')}`,
      `Category: ${esc(parsed.category)}`,
      `Company: ${esc(branch?.name ?? 'Unavailable')}${state.branchDetected ? ' (from the invoice)' : ''}`,
      `Client: ${esc(client?.name ?? 'None')}`,
    ].join('\n') + warnings
  );
}

/** The confirm screen: save with one tap, or correct any field first. */
async function showExpenseReview(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  state: ExpenseState,
  question = 'Save this expense?'
): Promise<void> {
  const parsed = state.parsed!;
  if (parsed.amountCents === null || !parsed.currency) return askExpenseAmount(env, api, branchId, userId, chatId);
  await saveSession(env.DB, userId, branchId, 'expense_invoice', 'confirm', state);
  const multipleCompanies = (await listBranches(env.DB)).length > 1;
  await api.sendMessage(chatId, `${await expenseSummary(env, state)}\n\n${question}`, [
    [{ text: `✅ Save ${formatCents(parsed.amountCents, parsed.currency)}`, callback_data: 'expenseconfirm:1' }],
    [
      { text: '✏️ Amount', callback_data: 'expenseamount:1' },
      { text: '📅 Date', callback_data: 'expedit:date' },
    ],
    [
      { text: '🏷 Category', callback_data: 'expedit:category' },
      { text: '👤 Client', callback_data: 'expedit:client' },
    ],
    ...(multipleCompanies ? [[{ text: '🏢 Company', callback_data: 'expedit:company' }]] : []),
    [reviewInAppRow(env, state.token!)[0], { text: 'Cancel', callback_data: 'cancel' }],
  ]);
}

async function loadExpenseSession(env: Bindings, branchId: number, userId: string) {
  const session = await getSession(env.DB, userId);
  if (!session || session.branch_id !== branchId || session.flow !== 'expense_invoice') {
    throw new Error('That expense import expired. Upload the supplier invoice again.');
  }
  const state = JSON.parse(session.data_json) as ExpenseState;
  if (!state.token || !state.parsed) throw new Error('That expense import expired. Upload the supplier invoice again.');
  state.targetBranchId ??= branchId;
  return { session, state };
}

async function askExpenseAmount(env: Bindings, api: TelegramApi, branchId: number, userId: string, chatId: string): Promise<void> {
  const { state } = await loadExpenseSession(env, branchId, userId);
  await saveSession(env.DB, userId, branchId, 'expense_invoice', 'amount', state);
  await api.sendMessage(
    chatId,
    `Send the amount paid, e.g. <b>12.40</b> (${esc(state.parsed!.currency ?? '')}) or <b>12.40 EUR</b>.`,
    [[{ text: 'Cancel', callback_data: 'cancel' }]]
  );
}

/** Field pickers opened from the confirm screen. */
async function editExpenseField(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  field: string
): Promise<void> {
  const { state } = await loadExpenseSession(env, branchId, userId);
  if (field === 'date') {
    const settings = await getSettings(env.DB, state.targetBranchId!);
    const today = todayInTz(settings.timezone);
    await saveSession(env.DB, userId, branchId, 'expense_invoice', 'date', state);
    await api.sendMessage(chatId, 'When was it paid? Tap an option or send a date (YYYY-MM-DD).', [
      [
        { text: `Today (${formatDateHuman(today)})`, callback_data: 'expday:0' },
        { text: 'Yesterday', callback_data: 'expday:1' },
      ],
      [{ text: 'Back', callback_data: 'expback' }],
    ]);
    return;
  }
  if (field === 'category') {
    await api.sendMessage(chatId, 'Choose a category.', [
      ...EXPENSE_CATEGORIES.map((category, i) => [
        { text: `${category === state.parsed!.category ? '✓ ' : ''}${category}`, callback_data: `expcat:${i + 1}` },
      ]),
      [{ text: 'Back', callback_data: 'expback' }],
    ]);
    return;
  }
  if (field === 'client') {
    const clients = (await listClientsForBranch(env.DB, state.targetBranchId!)).slice(0, 30);
    await api.sendMessage(
      chatId,
      clients.length ? 'Which client is this cost for?' : 'This company has no clients yet.',
      [
        ...clients.map((client) => [
          { text: `${client.id === state.clientId ? '✓ ' : ''}${client.name}`.slice(0, 60), callback_data: `expclient:${client.id}` },
        ]),
        [{ text: 'No client', callback_data: 'expclient:0' }],
        [{ text: 'Back', callback_data: 'expback' }],
      ]
    );
    return;
  }
  if (field === 'company') {
    const branches = await listBranches(env.DB);
    await api.sendMessage(chatId, 'Which company paid this?', [
      ...branches.map((branch) => [
        {
          text: `${branch.id === state.targetBranchId ? '✓ ' : ''}${branch.name}`.slice(0, 60),
          callback_data: `expcompany:${branch.id}`,
        },
      ]),
      [{ text: 'Back', callback_data: 'expback' }],
    ]);
    return;
  }
  throw new Error('That option is no longer available.');
}

async function setExpenseField(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  field: string,
  value: number
): Promise<void> {
  const { state } = await loadExpenseSession(env, branchId, userId);
  const parsed = state.parsed!;
  if (field === 'expday') {
    if (value !== 0 && value !== 1) throw new Error('That option is no longer available.');
    const settings = await getSettings(env.DB, state.targetBranchId!);
    parsed.expenseDate = addDaysISO(todayInTz(settings.timezone), -value);
    parsed.warnings = parsed.warnings.filter((warning) => !/date/i.test(warning));
  } else if (field === 'expcat') {
    const category = EXPENSE_CATEGORIES[value - 1];
    if (!category) throw new Error('That category is no longer available.');
    parsed.category = category;
  } else if (field === 'expclient') {
    if (value !== 0 && !(await getClientForBranch(env.DB, value, state.targetBranchId!))) {
      throw new Error('That client is unavailable for this company.');
    }
    state.clientId = value || null;
  } else if (field === 'expcompany') {
    if (!(await getBranch(env.DB, value))) throw new Error('That company is unavailable.');
    if (value !== state.targetBranchId) state.clientId = null; // clients are per company
    state.targetBranchId = value;
    state.branchDetected = false;
  }
  await showExpenseReview(env, api, branchId, userId, chatId, state);
}

async function continueExpenseImport(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  step: string,
  state: ExpenseState,
  text: string
): Promise<void> {
  if (!state.token || !state.parsed) throw new Error('That expense import expired. Upload the supplier invoice again.');
  state.targetBranchId ??= branchId;
  if (step === 'amount') {
    const money = parseMoneyReply(text);
    if (!money) throw new Error('Enter the amount paid, e.g. 12.40 or 12.40 EUR.');
    state.parsed.amountCents = money.cents;
    if (money.currency) state.parsed.currency = money.currency;
    if (state.parsed.taxCents !== null && state.parsed.taxCents >= money.cents) state.parsed.taxCents = null;
    state.parsed.warnings = state.parsed.warnings.filter((warning) => !/total/i.test(warning));
  } else if (step === 'payee') {
    const payee = text.replace(/\s+/g, ' ').trim();
    if (payee.length < 2 || payee.length > 120) throw new Error('Supplier name must be between 2 and 120 characters.');
    state.parsed.payee = payee;
    state.parsed.warnings = state.parsed.warnings.filter((warning) => !/supplier/i.test(warning));
  } else if (step === 'date') {
    const answer = text.trim().toLowerCase();
    const settings = await getSettings(env.DB, state.targetBranchId);
    const today = todayInTz(settings.timezone);
    const date = answer === 'today' ? today : answer === 'yesterday' ? addDaysISO(today, -1) : text.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new Error('Use a real date in YYYY-MM-DD format, or tap one of the buttons.');
    }
    if (date > today) throw new Error('An expense can’t be dated in the future.');
    state.parsed.expenseDate = date;
    state.parsed.warnings = state.parsed.warnings.filter((warning) => !/date/i.test(warning));
  }
  if (!state.parsed.payee) {
    await saveSession(env.DB, userId, branchId, 'expense_invoice', 'payee', state);
    await api.sendMessage(chatId, 'Who was paid? Send the supplier or shop name.', [[{ text: 'Cancel', callback_data: 'cancel' }]]);
    return;
  }
  await showExpenseReview(env, api, branchId, userId, chatId, state);
}

async function confirmExpenseImport(env: Bindings, api: TelegramApi, branchId: number, userId: string, chatId: string): Promise<void> {
  const { session, state } = await loadExpenseSession(env, branchId, userId);
  if (session.step !== 'confirm') throw new Error('Finish the current step first, or press Cancel.');
  const parsed = state.parsed!;
  if (parsed.amountCents === null || !parsed.currency) return askExpenseAmount(env, api, branchId, userId, chatId);
  if (!parsed.payee) {
    await saveSession(env.DB, userId, branchId, 'expense_invoice', 'payee', state);
    await api.sendMessage(chatId, 'Who was paid? Send the supplier or shop name.', [[{ text: 'Cancel', callback_data: 'cancel' }]]);
    return;
  }
  const target = await getBranch(env.DB, state.targetBranchId!);
  if (!target) throw new Error('That company is unavailable. Choose another company.');
  if (state.clientId && !(await getClientForBranch(env.DB, state.clientId, target.id))) {
    throw new Error('That client is no longer linked to this company. Choose the client again.');
  }
  const settings = await getSettings(env.DB, target.id);
  const expenseId = await createExpenseFromInvoiceImport(env.DB, state.token!, {
    branch_id: target.id,
    client_id: state.clientId ?? null,
    expense_date: parsed.expenseDate ?? todayInTz(settings.timezone),
    payee: parsed.payee,
    category: parsed.category,
    description: state.kind === 'image' ? 'Receipt photo uploaded from Telegram' : 'Supplier invoice uploaded from Telegram',
    reference: parsed.reference,
    amount_cents: parsed.amountCents,
    tax_cents: parsed.taxCents ?? 0,
    currency: parsed.currency,
  });
  if (!expenseId) throw new Error('That expense import expired or was already saved.');
  await clearSession(env.DB, userId);
  const active = await getBranch(env.DB, branchId);
  await api.sendMessage(
    chatId,
    `✅ Expense saved to <b>${esc(target.name)}</b>: ${esc(parsed.payee)} — ${esc(formatCents(parsed.amountCents, parsed.currency))}`,
    [
      [{ text: 'View expense', url: `${env.APP_BASE_URL}/admin/expenses/${expenseId}` }],
      ...homeKeyboard(active?.invoicing_enabled === 0),
    ]
  );
}

// ---------- Files sent to the bot ----------

async function handleAttachment(
  env: Bindings,
  api: TelegramApi,
  branchId: number,
  userId: string,
  chatId: string,
  message: TelegramMessage
): Promise<void> {
  const session = await getSession(env.DB, userId);
  if (session?.branch_id === branchId && session.flow === 'expense_invoice') {
    // A new file mid-review replaces the pending import.
    const pending = (JSON.parse(session.data_json) as ExpenseState).token;
    if (pending) await deleteExpenseInvoiceImport(env.DB, pending);
    return handleExpenseInvoiceUpload(env, api, branchId, userId, chatId, message);
  }
  if (!session || session.branch_id !== branchId || session.flow !== 'attach_invoice') {
    // No flow in progress: a file on its own is treated as an expense upload.
    if (!session) return handleExpenseInvoiceUpload(env, api, branchId, userId, chatId, message);
    throw new Error('Choose “Attach files” on an invoice before sending a file.');
  }
  const invoiceId = Number((JSON.parse(session.data_json) as { invoiceId: number }).invoiceId);
  const invoice = await getInvoice(env.DB, branchId, invoiceId);
  if (!invoice) throw new Error('Invoice not found in your company.');
  const photo = message.photo?.at(-1);
  const document = message.document;
  const source = document ?? photo;
  if (!source) throw new Error('No file was found in that message.');
  if ((source.file_size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error('That file is larger than the 1 MB limit.');
  const declaredMime = document?.mime_type ?? 'image/jpeg';
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(declaredMime)) {
    throw new Error('Only JPG, PNG, and PDF files are supported.');
  }
  const bytes = await api.downloadFile(source.file_id, MAX_ATTACHMENT_BYTES);
  const mime = sniffMime(bytes);
  if (!mime || mime !== declaredMime) throw new Error('The file contents do not match an allowed JPG, PNG, or PDF.');
  const filename = sanitizeFilename(document?.file_name ?? `telegram-photo-${message.message_id}.jpg`, mime);
  const existing = await listInvoiceAttachments(env.DB, invoiceId);
  if (existing.length >= 8 || existing.reduce((sum, item) => sum + item.size_bytes, 0) + bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error('An invoice can have up to 8 Telegram attachments totalling 4 MB.');
  }
  const result = await addInvoiceAttachment(env.DB, {
    invoice_id: invoiceId,
    bytes,
    mime,
    filename,
    size_bytes: bytes.byteLength,
    telegramFileId: source.file_id,
    telegramFileUniqueId: source.file_unique_id,
    telegramUserId: userId,
  });
  await logInvoiceEvent(
    env.DB,
    invoiceId,
    'edited',
    `Telegram attachment ${result === 'stored' ? 'added' : 'already present'}: ${filename}`
  );
  await api.sendMessage(
    chatId,
    result === 'stored' ? `✅ Attached <b>${esc(filename)}</b>. Send another or press Done.` : 'That file is already attached.',
    [
      [
        { text: 'Done', callback_data: 'attachdone' },
        { text: 'Cancel', callback_data: 'cancel' },
      ],
    ]
  );
}

// ---------- Helpers ----------

function newExpenseImportToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

type SniffedMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

function sniffMime(bytes: Uint8Array): SniffedMime | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }
  if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-') return 'application/pdf';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function sanitizeFilename(name: string, mime: SniffedMime): string {
  const extension =
    mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  const stem =
    name
      .replace(/\.[^.]*$/, '')
      .normalize('NFKC')
      .replace(/[^a-zA-Z0-9._ -]/g, '_')
      .replace(/\.{2,}/g, '.')
      .trim()
      .slice(0, 100) || 'attachment';
  return `${stem}${extension}`;
}

function firstLine(value: string, max: number): string {
  const line = value.split('\n')[0].trim();
  return line.length > max || value.includes('\n') ? `${line.slice(0, max)}…` : line;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function humanError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  if (/constraint|SQLITE|D1_/i.test(message)) return 'I couldn’t save that safely. Please try again or use the invoicing app.';
  return message.slice(0, 300);
}
