// Submissions bot: people who are not admins send expenses and income for
// Jin&Jaw Arabia, with a photo or PDF of the invoice or as typed text. Each
// request waits for an admin to approve it in the admin bot (see review.ts);
// only then is it written to the expenses or income ledger.

import type { Bindings } from '../../env';
import { getSettings, listBranches, type Branch } from '../../db/queries';
import { addDaysISO, formatDateHuman, todayInTz } from '../../lib/dates';
import { EXPENSE_CATEGORIES, isIsoDate, MAX_EXPENSE_ATTACHMENT_BYTES } from '../../lib/expenses';
import { extractExpenseInvoiceText, parseExpenseInvoice, type ParsedExpenseInvoice } from '../../lib/expense-invoice-import';
import { parseMoneyReply, parseQuickEntry } from '../../lib/telegram-input';
import { readReceiptImage, parseReceiptFields, type ReceiptImageMime } from '../receipt-ocr';
import { TelegramApi, type InlineKeyboard, type TelegramMessage, type TelegramUser } from '../telegram/api';
import type { TelegramUpdate } from '../telegram/handler';
import { consumeRateLimit, sha256Hex } from '../telegram/repository';
import { esc, evidenceSource, humanError, sanitizeFilename, sniffMime } from '../telegram/util';
import {
  claimSubmissionsUpdate,
  createDraft,
  deleteDraft,
  getDraft,
  getSubmissionsBranch,
  getSubmitter,
  listSubmitterRequests,
  requestAccess,
  setDraftFile,
  submitDraft,
  touchSubmitter,
  updateDraft,
  type DraftPatch,
  type Submission,
  type SubmissionKind,
  type Submitter,
} from './repository';
import { amountLabel, kindLabel, partyLabel, submissionLines, submissionsMenuKeyboard } from './format';
import { notifyAdminsOfAccessRequest, notifyAdminsOfSubmission } from './review';

type Context = {
  env: Bindings;
  api: TelegramApi;
  chatId: string;
  submitter: Submitter;
  branch: Branch;
};

const NOTE_MAX = 500;

const CANCEL_ROW: InlineKeyboard[number] = [{ text: 'Cancel', callback_data: 'cancel' }];

export async function handleSubmissionsUpdate(env: Bindings, update: TelegramUpdate): Promise<void> {
  const api = new TelegramApi(env.SUBMISSIONS_BOT_TOKEN!);
  if (!(await claimSubmissionsUpdate(env.DB, update.update_id))) return;
  const callback = update.callback_query;
  const message = update.message ?? callback?.message;
  const user = update.message?.from ?? callback?.from;
  if (!message || !user) return;
  const userId = String(user.id);
  const chatId = String(message.chat.id);

  if (message.chat.type !== 'private') {
    if (update.message?.text?.startsWith('/start')) {
      await api.sendMessage(chatId, 'Open a private chat with this bot to send expenses and income.');
    }
    return;
  }
  // A separate key keeps this budget apart from the same person's admin bot use.
  if (!(await consumeRateLimit(env.DB, `submissions:${userId}`))) {
    await api.sendMessage(chatId, 'Please slow down for a moment and try again.');
    return;
  }

  try {
    if (callback) await api.answerCallbackQuery(callback.id);
    const branch = await getSubmissionsBranch(env.DB);
    if (!branch) {
      await api.sendMessage(chatId, 'This bot isn’t set up yet. Please ask the admin.');
      return;
    }
    const name = displayName(user);
    const username = user.username ?? null;
    const submitter = await getSubmitter(env.DB, userId);
    if (!submitter) {
      const created = await requestAccess(env.DB, { userId, chatId, username, displayName: name });
      await api.sendMessage(
        chatId,
        `Hi ${esc(name)}. This bot sends expenses and income for <b>${esc(branch.name)}</b> to the admin for approval.\n\nI’ve asked the admin to give you access, and I’ll message you here once they do.`
      );
      if (created) await notifyAdminsOfAccessRequest(env, created, branch);
      return;
    }
    await touchSubmitter(env.DB, userId, chatId, username, name);
    if (submitter.status === 'pending') {
      await api.sendMessage(chatId, 'Your access request is still waiting for the admin. I’ll message you once it’s approved.');
      return;
    }
    if (submitter.status !== 'active') {
      await api.sendMessage(chatId, 'You don’t have access to this bot. Please ask the admin if you think this is a mistake.');
      return;
    }

    const ctx: Context = { env, api, chatId, submitter: { ...submitter, telegram_chat_id: chatId }, branch };
    const draft = await getDraft(env.DB, submitter.id);
    if (callback) return handleCallback(ctx, draft, callback.data ?? '');
    if (update.message?.document || update.message?.photo?.length) return receiveFile(ctx, draft, update.message);

    const text = update.message?.text?.trim() ?? '';
    const command = text.split(/\s+/, 1)[0].toLowerCase().replace(/@[^\s]+$/, '');
    if (command.startsWith('/')) {
      if (command === '/expense') return startDraft(ctx, 'expense');
      if (command === '/income') return startDraft(ctx, 'income');
      if (command === '/mine' || command === '/requests') return showMine(ctx);
      if (command === '/cancel') return cancelDraft(ctx);
      return showMenu(ctx, draft);
    }
    if (!text) return showMenu(ctx, draft);
    await receiveText(ctx, draft, text);
  } catch (error) {
    console.error(JSON.stringify({ event: 'submissions_update_failed', updateId: update.update_id, userId, error: String(error) }));
    await api.sendMessage(chatId, `❌ ${humanError(error)}`).catch(() => undefined);
  }
}

function displayName(user: TelegramUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return (name || (user.username ? `@${user.username}` : `Telegram user ${user.id}`)).slice(0, 80);
}

async function showMenu(ctx: Context, draft: Submission | null): Promise<void> {
  const keyboard = submissionsMenuKeyboard();
  if (draft) keyboard.unshift([{ text: '✏️ Continue the request you started', callback_data: 'continue' }]);
  await ctx.api.sendMessage(
    ctx.chatId,
    [
      `<b>${esc(ctx.branch.name)}</b>`,
      '',
      'Send an expense or income with a photo or PDF of the invoice, or type it. The admin approves each request before it’s recorded.',
      '',
      '/expense: money paid out',
      '/income: money received',
      '/mine: your recent requests',
      '/cancel: drop the request you’re filling in',
    ].join('\n'),
    keyboard
  );
}

async function handleCallback(ctx: Context, draft: Submission | null, data: string): Promise<void> {
  if (data === 'expense' || data === 'income') return startDraft(ctx, data);
  if (data === 'mine') return showMine(ctx);
  if (data === 'menu') return showMenu(ctx, draft);
  if (data === 'cancel') return cancelDraft(ctx);
  if (!draft) throw new Error('That request expired. Start again with /expense or /income.');
  if (data === 'continue' || data === 'back') return continueDraft(ctx, draft);
  if (data === 'kind:expense' || data === 'kind:income') return chooseKind(ctx, draft, data.slice(5) as SubmissionKind);
  if (data === 'submit') return submit(ctx, draft);
  if (data === 'nonote') return showReview(ctx, await updateDraft(ctx.env.DB, draft, { note: null, step: 'review' }));
  if (data.startsWith('edit:')) return editField(ctx, draft, data.slice(5));
  const day = data.match(/^day:([01])$/);
  if (day) {
    const today = await todayFor(ctx);
    return showReview(ctx, await updateDraft(ctx.env.DB, draft, { entry_date: addDaysISO(today, -Number(day[1])), step: 'review' }));
  }
  const category = data.match(/^cat:(\d{1,2})$/);
  if (category) {
    const chosen = EXPENSE_CATEGORIES[Number(category[1]) - 1];
    if (!chosen) throw new Error('That category is no longer available.');
    return showReview(ctx, await updateDraft(ctx.env.DB, draft, { category: chosen, step: 'review' }));
  }
  throw new Error('That button is no longer valid. Send /expense or /income to start again.');
}

async function todayFor(ctx: Context): Promise<string> {
  return todayInTz((await getSettings(ctx.env.DB, ctx.branch.id)).timezone);
}

async function startDraft(ctx: Context, kind: SubmissionKind): Promise<void> {
  const draft = await createDraft(ctx.env.DB, ctx.submitter.id, ctx.branch.id, { kind, step: 'file' });
  await askStep(ctx, draft, 'file');
}

async function cancelDraft(ctx: Context): Promise<void> {
  await deleteDraft(ctx.env.DB, ctx.submitter.id);
  await ctx.api.sendMessage(ctx.chatId, 'Cancelled.', submissionsMenuKeyboard());
}

// ---------- Filling in a draft ----------

/** The next thing the draft needs, or 'review' once it can be sent. */
function nextStep(draft: Submission): string {
  if (!draft.kind) return 'kind';
  if (draft.amount_cents === null) return 'amount';
  if (!draft.party) return 'party';
  return 'review';
}

async function continueDraft(ctx: Context, draft: Submission, note = ''): Promise<void> {
  const step = nextStep(draft);
  if (step === 'review') return showReview(ctx, draft, note);
  await askStep(ctx, draft, step, note);
}

async function askStep(ctx: Context, draft: Submission, step: string, note = ''): Promise<void> {
  const current = draft.step === step ? draft : await updateDraft(ctx.env.DB, draft, { step });
  const { api, chatId } = ctx;
  if (step === 'kind') {
    await api.sendMessage(chatId, `${note}Is this an expense or income?`, [
      [
        { text: '📤 Expense (paid out)', callback_data: 'kind:expense' },
        { text: '📥 Income (received)', callback_data: 'kind:income' },
      ],
      CANCEL_ROW,
    ]);
    return;
  }
  if (step === 'file') {
    await api.sendMessage(
      chatId,
      `${note}<b>New ${kindLabel(current.kind)}</b>\n\nSend a photo or PDF of the invoice or receipt.\n\nNo invoice? Type it instead, e.g. <code>Taxi to airport 25</code> or <code>120 EUR</code>.`,
      [CANCEL_ROW]
    );
    return;
  }
  if (step === 'amount') {
    const currency = current.currency ?? (await getSettings(ctx.env.DB, ctx.branch.id)).currency;
    await api.sendMessage(
      chatId,
      `${note}How much was ${current.kind === 'income' ? 'received' : 'paid'}? Send an amount in ${esc(currency)}, e.g. <b>25</b>, or add a currency, e.g. <b>25 EUR</b>.`,
      [CANCEL_ROW]
    );
    return;
  }
  if (step === 'party') {
    const question =
      current.kind === 'income' ? 'Who paid? Send the client’s name.' : 'Who was paid? Send the supplier or shop name.';
    await api.sendMessage(chatId, `${note}${question}`, [CANCEL_ROW]);
    return;
  }
  if (step === 'date') {
    const today = await todayFor(ctx);
    await api.sendMessage(
      chatId,
      `${note}When was it ${current.kind === 'income' ? 'received' : 'paid'}? Tap an option or send a date (YYYY-MM-DD).`,
      [
        [
          { text: `Today (${formatDateHuman(today)})`, callback_data: 'day:0' },
          { text: 'Yesterday', callback_data: 'day:1' },
        ],
        [{ text: 'Back', callback_data: 'back' }],
      ]
    );
    return;
  }
  if (step === 'note') {
    await api.sendMessage(chatId, `${note}Send a note for the admin, e.g. what it was for.`, [
      [{ text: 'No note', callback_data: 'nonote' }],
      [{ text: 'Back', callback_data: 'back' }],
    ]);
    return;
  }
  throw new Error('That step is no longer available.');
}

async function chooseKind(ctx: Context, draft: Submission, kind: SubmissionKind): Promise<void> {
  if (draft.kind) return continueDraft(ctx, draft);
  let updated = await updateDraft(ctx.env.DB, draft, { kind });
  // A file sent before the kind was known is read now.
  if (updated.file_mime) updated = await applyEvidence(ctx, updated);
  await continueDraft(ctx, updated, readNote(updated));
}

async function editField(ctx: Context, draft: Submission, field: string): Promise<void> {
  if (field === 'amount' || field === 'party' || field === 'date' || field === 'note') return askStep(ctx, draft, field);
  if (field === 'category' && draft.kind === 'expense') {
    await ctx.api.sendMessage(ctx.chatId, 'Choose a category.', [
      ...EXPENSE_CATEGORIES.map((category, i) => [
        { text: `${category === draft.category ? '✓ ' : ''}${category}`, callback_data: `cat:${i + 1}` },
      ]),
      [{ text: 'Back', callback_data: 'back' }],
    ]);
    return;
  }
  throw new Error('That option is no longer available.');
}

async function receiveText(ctx: Context, draft: Submission | null, text: string): Promise<void> {
  const { env } = ctx;
  if (!draft) {
    const quick = parseQuickEntry(text);
    if (!quick) return showMenu(ctx, null);
    const created = await createDraft(env.DB, ctx.submitter.id, ctx.branch.id, {
      amount_cents: quick.cents,
      currency: quick.currency ?? undefined,
      party: quick.party ?? undefined,
    });
    return askStep(ctx, created, 'kind');
  }
  const step = draft.step ?? nextStep(draft);
  if (step === 'kind') return askStep(ctx, draft, 'kind', 'Tap Expense or Income first.\n\n');
  if (step === 'file') {
    const quick = parseQuickEntry(text);
    if (!quick) {
      throw new Error('Send a photo or PDF of the invoice, or type the amount, e.g. Taxi to airport 25.');
    }
    const updated = await updateDraft(env.DB, draft, {
      amount_cents: quick.cents,
      ...(quick.currency ? { currency: quick.currency } : {}),
      ...(quick.party ? { party: quick.party } : {}),
    });
    return continueDraft(ctx, updated);
  }
  if (step === 'amount') {
    const money = parseMoneyReply(text);
    if (!money) throw new Error('Send a valid amount greater than zero, e.g. 25 or 25 EUR.');
    const patch: DraftPatch = { amount_cents: money.cents };
    if (money.currency) patch.currency = money.currency;
    if (draft.tax_cents >= money.cents) patch.tax_cents = 0;
    return continueDraft(ctx, await updateDraft(env.DB, draft, patch));
  }
  if (step === 'party') {
    const party = text.replace(/\s+/g, ' ').trim();
    if (party.length < 2 || party.length > 120) throw new Error('The name must be between 2 and 120 characters.');
    return continueDraft(ctx, await updateDraft(env.DB, draft, { party }));
  }
  if (step === 'date') {
    const today = await todayFor(ctx);
    const answer = text.trim().toLowerCase();
    const date = answer === 'today' ? today : answer === 'yesterday' ? addDaysISO(today, -1) : text.trim();
    if (!isIsoDate(date)) throw new Error('Use a real date in YYYY-MM-DD format, or tap one of the buttons.');
    if (date > today) throw new Error('The date can’t be in the future.');
    return showReview(ctx, await updateDraft(env.DB, draft, { entry_date: date, step: 'review' }));
  }
  if (step === 'note') {
    const note = text.trim().toLowerCase() === 'none' ? null : text.trim().slice(0, NOTE_MAX);
    return showReview(ctx, await updateDraft(env.DB, draft, { note, step: 'review' }));
  }
  await showReview(ctx, draft, 'Use the buttons below to change a detail.\n\n');
}

// ---------- Files ----------

async function receiveFile(ctx: Context, draft: Submission | null, message: TelegramMessage): Promise<void> {
  const { env, api } = ctx;
  const source = evidenceSource(message);
  if ((source.size ?? 0) > MAX_EXPENSE_ATTACHMENT_BYTES) throw new Error('That file is larger than the 1.5 MB limit.');
  const bytes = await api.downloadFile(source.fileId, MAX_EXPENSE_ATTACHMENT_BYTES);
  const mime = sniffMime(bytes);
  if (!mime || (mime === 'application/pdf') !== (source.declaredMime === 'application/pdf')) {
    throw new Error('The file contents are not a valid PDF, JPG, PNG or WebP.');
  }
  const fallbackName = mime === 'application/pdf' ? `invoice-${message.message_id}` : `receipt-${message.message_id}`;
  const file = {
    bytes,
    mime,
    filename: sanitizeFilename(source.name ?? fallbackName, mime),
    size_bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
  // A file with no request started is kept while the sender says what it is.
  let current = draft ?? (await createDraft(env.DB, ctx.submitter.id, ctx.branch.id, {}));
  current = await setDraftFile(env.DB, current, file);
  if (!current.kind) return askStep(ctx, current, 'kind', '📎 Got the file.\n\n');
  await api.sendChatAction(ctx.chatId, 'typing').catch(() => undefined);
  current = await applyEvidence(ctx, current);
  await continueDraft(ctx, current, readNote(current));
}

/** One line on what was read from the file, shown above the next question. */
function readNote(draft: Submission): string {
  if (!draft.file_mime) return '';
  if (draft.amount_cents === null) return '📎 Got the file, but I couldn’t read the total.\n\n';
  return '📎 Got the file.\n\n';
}

/**
 * Read the draft's file and copy what was found onto it. A value read from
 * the file replaces a typed one, because a new file is usually a correction.
 * Income invoices name the paying client, not the supplier, so the supplier
 * the reader finds is only used for expenses.
 */
async function applyEvidence(ctx: Context, draft: Submission): Promise<Submission> {
  const { env } = ctx;
  const row = await env.DB.prepare('SELECT file_bytes FROM submissions WHERE id = ?')
    .bind(draft.id)
    .first<{ file_bytes: ArrayBuffer | number[] | null }>();
  if (!row?.file_bytes) return draft;
  const bytes = row.file_bytes instanceof ArrayBuffer ? new Uint8Array(row.file_bytes) : Uint8Array.from(row.file_bytes);
  const parsed = await readEvidence(env, bytes, draft.file_mime!);
  const today = await todayFor(ctx);
  const patch: DraftPatch = {};
  if (parsed.amountCents !== null) {
    patch.amount_cents = parsed.amountCents;
    patch.tax_cents = parsed.taxCents !== null && parsed.taxCents < parsed.amountCents ? parsed.taxCents : 0;
    if (parsed.currency) patch.currency = parsed.currency;
  }
  if (parsed.expenseDate && isIsoDate(parsed.expenseDate) && parsed.expenseDate <= today) patch.entry_date = parsed.expenseDate;
  if (parsed.reference) patch.reference = parsed.reference.slice(0, 120);
  if (draft.kind === 'expense') {
    if (parsed.payee) patch.party = parsed.payee.slice(0, 120);
    if (!draft.category) patch.category = parsed.category;
  }
  return updateDraft(env.DB, draft, patch);
}

async function readEvidence(env: Bindings, bytes: Uint8Array, mime: string): Promise<ParsedExpenseInvoice> {
  if (mime !== 'application/pdf') return readReceiptImage(env.AI, bytes, mime as ReceiptImageMime);
  try {
    const extraction = await extractExpenseInvoiceText(bytes);
    const branches = await listBranches(env.DB);
    return parseExpenseInvoice(extraction.lines, branches.map((branch) => branch.name));
  } catch (error) {
    // A scanned or damaged PDF is still kept as evidence; the sender types the details.
    console.error(JSON.stringify({ event: 'submission_pdf_read_failed', error: String(error) }));
    return parseReceiptFields(null);
  }
}

// ---------- Review and send ----------

async function showReview(ctx: Context, draft: Submission, note = ''): Promise<void> {
  const settings = await getSettings(ctx.env.DB, ctx.branch.id);
  // Fill the defaults the sender didn't give, so what they see is what gets sent.
  const defaults: DraftPatch = { step: 'review' };
  if (!draft.entry_date) defaults.entry_date = todayInTz(settings.timezone);
  if (!draft.currency) defaults.currency = settings.currency;
  if (draft.kind === 'expense' && !draft.category) defaults.category = 'Other';
  const current = await updateDraft(ctx.env.DB, draft, defaults);
  const attachHint = current.file_name ? '' : '\n\nYou can still send a photo or PDF of the invoice.';
  await ctx.api.sendMessage(
    ctx.chatId,
    `${note}<b>${current.kind === 'income' ? 'Income' : 'Expense'} request</b> (not sent yet)\n\n${submissionLines(
      current,
      settings.currency
    ).join('\n')}${attachHint}\n\nTap <b>Send for approval</b> when it’s right.`,
    [
      [{ text: '✅ Send for approval', callback_data: 'submit' }],
      [
        { text: '✏️ Amount', callback_data: 'edit:amount' },
        { text: `👤 ${partyLabel(current.kind)}`, callback_data: 'edit:party' },
      ],
      [
        { text: '📅 Date', callback_data: 'edit:date' },
        current.kind === 'expense'
          ? { text: '🏷 Category', callback_data: 'edit:category' }
          : { text: '📝 Note', callback_data: 'edit:note' },
      ],
      ...(current.kind === 'expense' ? [[{ text: '📝 Note', callback_data: 'edit:note' }]] : []),
      CANCEL_ROW,
    ]
  );
}

async function submit(ctx: Context, draft: Submission): Promise<void> {
  if (nextStep(draft) !== 'review' || draft.step !== 'review') return continueDraft(ctx, draft);
  if (!(await submitDraft(ctx.env.DB, draft))) throw new Error('That request is missing a detail. Check it and try again.');
  await ctx.api.sendMessage(
    ctx.chatId,
    `📨 Sent for approval as request <b>#${draft.id}</b>. I’ll message you when the admin approves or rejects it.`,
    submissionsMenuKeyboard()
  );
  console.log(JSON.stringify({ event: 'submission_sent', submissionId: draft.id, submitterId: draft.submitter_id }));
  await notifyAdminsOfSubmission(ctx.env, draft.id);
}

async function showMine(ctx: Context): Promise<void> {
  const requests = await listSubmitterRequests(ctx.env.DB, ctx.submitter.id);
  if (!requests.length) {
    await ctx.api.sendMessage(ctx.chatId, '<b>My requests</b>\n\nYou haven’t sent any requests yet.', submissionsMenuKeyboard());
    return;
  }
  const icon = { draft: '✏️', pending: '⏳', approved: '✅', rejected: '❌' } as const;
  const lines = requests.map((request) => {
    const amount = amountLabel(request);
    const reason = request.status === 'rejected' && request.decision_note ? `\n    Reason: ${esc(request.decision_note)}` : '';
    return `${icon[request.status]} #${request.id} ${kindLabel(request.kind)}: ${esc(request.party ?? '')} ${esc(amount)}${reason}`;
  });
  await ctx.api.sendMessage(
    ctx.chatId,
    `<b>My requests</b>\n\n${lines.join('\n')}\n\n⏳ waiting · ✅ approved · ❌ rejected`,
    submissionsMenuKeyboard()
  );
}
