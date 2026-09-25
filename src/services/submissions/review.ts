// Admin side of the submissions bot. Requests and access requests arrive in
// the admin bot as cards with Approve and Reject buttons; the decision is
// then sent back to the submitter through the submissions bot.

import type { Bindings } from '../../env';
import { getBranch, type Branch } from '../../db/queries';
import { formatCents } from '../../lib/money';
import { TelegramApi, telegramApi, type InlineKeyboard, type TelegramCallbackQuery } from '../telegram/api';
import { clearSession, getSession, saveSession, type TelegramConnection } from '../telegram/repository';
import { esc } from '../telegram/util';
import { amountLabel, kindLabel, submissionLines, submissionsMenuKeyboard } from './format';
import {
  approveSubmission,
  deleteDraft,
  getSubmission,
  getSubmissionFile,
  getSubmitterById,
  listPendingSubmissions,
  listSubmitters,
  rejectSubmission,
  setSubmitterStatus,
  type SubmissionFile,
  type SubmissionWithSubmitter,
  type Submitter,
} from './repository';

const REVIEW_CALLBACK = /^(subok|subno|subnox|subview|suballow|subdeny|subrevoke):(\d{1,9})$/;

/** Telegram's limit for a photo or document caption. */
const CAPTION_LIMIT = 1024;

type RejectState = { submissionId: number; cardMessageId?: number };

function submissionsApi(env: Bindings): TelegramApi | null {
  return env.SUBMISSIONS_BOT_TOKEN ? new TelegramApi(env.SUBMISSIONS_BOT_TOKEN) : null;
}

async function adminChats(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare('SELECT DISTINCT telegram_chat_id FROM telegram_connections WHERE personal_notifications = 1')
    .all<{ telegram_chat_id: string }>();
  return rows.results.map((row) => row.telegram_chat_id);
}

function who(person: { display_name: string; telegram_username: string | null }): string {
  return `${esc(person.display_name)}${person.telegram_username ? ` (@${esc(person.telegram_username)})` : ''}`;
}

function cardText(submission: SubmissionWithSubmitter, branch: Branch | null): string {
  const title = submission.kind === 'income' ? '📥 <b>Income request' : '🧾 <b>Expense request';
  const status =
    submission.status === 'approved'
      ? '\n\n✅ Approved'
      : submission.status === 'rejected'
        ? `\n\n❌ Rejected${submission.decision_note ? `: ${esc(submission.decision_note)}` : ''}`
        : '';
  return [
    `${title} #${submission.id}</b>`,
    `From: ${who(submission)}`,
    `Company: ${esc(branch?.name ?? 'Unavailable')}`,
    '',
    ...submissionLines(submission, branch?.currency ?? 'USD'),
  ].join('\n') + status;
}

function decisionButtons(id: number): InlineKeyboard {
  return [
    [
      { text: '✅ Approve', callback_data: `subok:${id}` },
      { text: '❌ Reject', callback_data: `subno:${id}` },
    ],
  ];
}

/** The card with the invoice itself: photos inline, PDFs and WebP as documents. */
async function sendCard(
  api: TelegramApi,
  chatId: string,
  text: string,
  file: SubmissionFile | null,
  keyboard?: InlineKeyboard
): Promise<void> {
  if (file && text.length <= CAPTION_LIMIT) {
    if (file.mime === 'image/jpeg' || file.mime === 'image/png') {
      try {
        await api.sendPhoto(chatId, file.bytes, file.filename, file.mime, text, keyboard);
        return;
      } catch (error) {
        // Telegram refuses some photos (very tall receipts); a document always works.
        console.error(JSON.stringify({ event: 'submission_photo_failed', error: String(error) }));
      }
    }
    await api.sendDocument(chatId, file.bytes, file.filename, text, { mime: file.mime, keyboard, html: true });
    return;
  }
  if (file) await api.sendDocument(chatId, file.bytes, file.filename, undefined, { mime: file.mime });
  await api.sendMessage(chatId, text, keyboard);
}

async function clearButtons(api: TelegramApi, chatId: string, messageId: number | undefined): Promise<void> {
  if (!messageId) return;
  await api.editMessageReplyMarkup(chatId, messageId).catch(() => undefined);
}

/** Messages the submitter through the submissions bot; a failure only logs. */
async function tellSubmitter(env: Bindings, chatId: string, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const api = submissionsApi(env);
  if (!api) return;
  await api.sendMessage(chatId, text, keyboard).catch((error) => {
    console.error(JSON.stringify({ event: 'submitter_message_failed', error: String(error) }));
  });
}

// ---------- Notifications ----------

export async function notifyAdminsOfSubmission(env: Bindings, submissionId: number): Promise<void> {
  const api = telegramApi(env);
  const submission = await getSubmission(env.DB, submissionId);
  if (!api || !submission) {
    console.error(JSON.stringify({ event: 'submission_notification_skipped', submissionId, botConfigured: !!api }));
    return;
  }
  const [branch, file] = await Promise.all([getBranch(env.DB, submission.branch_id), getSubmissionFile(env.DB, submissionId)]);
  const text = cardText(submission, branch);
  for (const chatId of await adminChats(env.DB)) {
    try {
      await sendCard(api, chatId, text, file, decisionButtons(submission.id));
    } catch (error) {
      console.error(JSON.stringify({ event: 'submission_notification_failed', submissionId, error: String(error) }));
    }
  }
}

export async function notifyAdminsOfAccessRequest(env: Bindings, submitter: Submitter, branch: Branch): Promise<void> {
  const api = telegramApi(env);
  if (!api) return;
  for (const chatId of await adminChats(env.DB)) {
    await api
      .sendMessage(
        chatId,
        `👤 <b>Access request</b>\n\n${who(submitter)} wants to send expenses and income for <b>${esc(branch.name)}</b> through the staff bot.`,
        [
          [
            { text: '✅ Allow', callback_data: `suballow:${submitter.id}` },
            { text: '❌ Deny', callback_data: `subdeny:${submitter.id}` },
          ],
        ]
      )
      .catch((error) => {
        console.error(JSON.stringify({ event: 'access_request_notification_failed', error: String(error) }));
      });
  }
}

// ---------- Admin bot commands and buttons ----------

export async function showPendingSubmissions(env: Bindings, api: TelegramApi, chatId: string): Promise<void> {
  const pending = await listPendingSubmissions(env.DB);
  if (!pending.length) {
    await api.sendMessage(chatId, '<b>Staff requests</b>\n\nNothing is waiting for approval.');
    return;
  }
  const lines = pending.map(
    (s) => `#${s.id} ${kindLabel(s.kind)} from ${esc(s.display_name)}: ${esc(s.party ?? '')}, ${esc(amountLabel(s))}`
  );
  await api.sendMessage(
    chatId,
    `<b>Staff requests waiting for approval</b>\n\n${lines.join('\n')}\n\nTap one to see it with its invoice.`,
    pending.map((s) => [{ text: `#${s.id} · ${amountLabel(s)} · ${s.party ?? ''}`.slice(0, 60), callback_data: `subview:${s.id}` }])
  );
}

export async function showSubmitters(env: Bindings, api: TelegramApi, chatId: string): Promise<void> {
  const submitters = await listSubmitters(env.DB);
  const username = env.SUBMISSIONS_BOT_USERNAME?.replace(/^@/, '');
  const share = username
    ? `Share https://t.me/${esc(username)} with staff. They press Start, then you allow them here.`
    : 'Staff open the staff bot and press Start, then you allow them here.';
  if (!submitters.length) {
    await api.sendMessage(chatId, `<b>Staff bot access</b>\n\n${share}\n\nNobody has asked for access yet.`);
    return;
  }
  const icon = { pending: '⏳', active: '✅', denied: '🚫', revoked: '🚫' } as const;
  const label = { pending: 'waiting for you', active: 'can send requests', denied: 'denied', revoked: 'removed' } as const;
  const lines = submitters.map((s) => `${icon[s.status]} ${who(s)}: ${label[s.status]}`);
  const keyboard: InlineKeyboard = submitters.map((s) => {
    const name = s.display_name.slice(0, 40);
    if (s.status === 'pending') {
      return [
        { text: `✅ Allow ${name}`, callback_data: `suballow:${s.id}` },
        { text: '❌ Deny', callback_data: `subdeny:${s.id}` },
      ];
    }
    if (s.status === 'active') return [{ text: `Remove ${name}`, callback_data: `subrevoke:${s.id}` }];
    return [{ text: `Allow ${name} again`, callback_data: `suballow:${s.id}` }];
  });
  await api.sendMessage(chatId, `<b>Staff bot access</b>\n\n${share}\n\n${lines.join('\n')}`, keyboard);
}

/** Handles the approval and access buttons; false when the callback is not one of them. */
export async function handleReviewCallback(
  env: Bindings,
  api: TelegramApi,
  connection: TelegramConnection,
  chatId: string,
  callback: TelegramCallbackQuery
): Promise<boolean> {
  const match = (callback.data ?? '').match(REVIEW_CALLBACK);
  if (!match) return false;
  const action = match[1];
  const id = Number(match[2]);
  const messageId = callback.message?.message_id;
  if (action === 'subview') await viewSubmission(env, api, chatId, id);
  else if (action === 'subok') await approve(env, api, connection, chatId, id, messageId);
  else if (action === 'subno') await askRejectReason(env, api, connection, chatId, id, messageId);
  else if (action === 'subnox') {
    const state = await rejectState(env, connection, id);
    await clearButtons(api, chatId, messageId);
    await reject(env, api, connection, chatId, id, null, state?.cardMessageId);
  } else await decideAccess(env, api, connection, chatId, id, action, messageId);
  return true;
}

/** A reason typed after tapping Reject. */
export async function handleRejectReason(
  env: Bindings,
  api: TelegramApi,
  connection: TelegramConnection,
  chatId: string,
  state: RejectState,
  text: string
): Promise<void> {
  const reason = text.trim().slice(0, 500);
  if (!reason) throw new Error('Send the reason as text, or tap Reject without a reason.');
  await reject(env, api, connection, chatId, state.submissionId, reason, state.cardMessageId);
}

async function viewSubmission(env: Bindings, api: TelegramApi, chatId: string, id: number): Promise<void> {
  const submission = await getSubmission(env.DB, id);
  if (!submission) throw new Error('That request no longer exists.');
  const [branch, file] = await Promise.all([getBranch(env.DB, submission.branch_id), getSubmissionFile(env.DB, id)]);
  await sendCard(api, chatId, cardText(submission, branch), file, submission.status === 'pending' ? decisionButtons(id) : undefined);
}

async function alreadyDecided(api: TelegramApi, chatId: string, id: number, messageId: number | undefined): Promise<void> {
  await clearButtons(api, chatId, messageId);
  await api.sendMessage(chatId, `Request #${id} has already been decided. Send /pending to see what’s still waiting.`);
}

/** What the ledger entry says about where it came from, plus the submitter's note. */
function ledgerText(submission: SubmissionWithSubmitter): string {
  const origin = `Staff bot request #${submission.id} from ${submission.display_name}${
    submission.telegram_username ? ` (@${submission.telegram_username})` : ''
  }`;
  if (submission.kind === 'income') {
    return [submission.reference, submission.note, origin].filter(Boolean).join(' · ').slice(0, 300);
  }
  return [origin, submission.note].filter(Boolean).join('\n').slice(0, 1000);
}

async function approve(
  env: Bindings,
  api: TelegramApi,
  connection: TelegramConnection,
  chatId: string,
  id: number,
  messageId: number | undefined
): Promise<void> {
  const submission = await getSubmission(env.DB, id);
  if (!submission) throw new Error('That request no longer exists.');
  if (submission.status !== 'pending') return alreadyDecided(api, chatId, id, messageId);
  const branch = await getBranch(env.DB, submission.branch_id);
  if (!branch) throw new Error('The company for this request is no longer active.');
  const entryId = await approveSubmission(env.DB, submission, connection.admin_subject, ledgerText(submission));
  if (!entryId) return alreadyDecided(api, chatId, id, messageId);
  await clearButtons(api, chatId, messageId);
  await clearRejectSession(env, connection, id);

  const kind = kindLabel(submission.kind);
  const amount = formatCents(submission.amount_cents!, submission.currency!);
  const link =
    submission.kind === 'income'
      ? { text: 'View reports', url: `${env.APP_BASE_URL}/admin/reports?workspace=${branch.workspace_id}` }
      : { text: 'View expense', url: `${env.APP_BASE_URL}/admin/expenses/${entryId}?workspace=${branch.workspace_id}` };
  await api.sendMessage(
    chatId,
    `✅ Approved request #${id}. The ${kind} is saved to <b>${esc(branch.name)}</b>: ${esc(submission.party ?? '')}, ${esc(amount)}.`,
    [[link]]
  );
  await tellSubmitter(
    env,
    submission.submitter_chat_id,
    `✅ Your ${kind} request <b>#${id}</b> was approved: ${esc(submission.party ?? '')}, ${esc(amount)}.`,
    submissionsMenuKeyboard()
  );
  console.log(JSON.stringify({ event: 'submission_approved', submissionId: id, kind, entryId }));
}

async function askRejectReason(
  env: Bindings,
  api: TelegramApi,
  connection: TelegramConnection,
  chatId: string,
  id: number,
  cardMessageId: number | undefined
): Promise<void> {
  const submission = await getSubmission(env.DB, id);
  if (!submission) throw new Error('That request no longer exists.');
  if (submission.status !== 'pending') return alreadyDecided(api, chatId, id, cardMessageId);
  const state: RejectState = { submissionId: id, cardMessageId };
  await saveSession(env.DB, connection.telegram_user_id, connection.branch_id, 'reject_submission', 'reason', state);
  await api.sendMessage(
    chatId,
    `Why are you rejecting request #${id}? ${esc(submission.display_name)} will see your reason.\n\nSend it as a message, or tap below.`,
    [
      [{ text: '❌ Reject without a reason', callback_data: `subnox:${id}` }],
      [{ text: 'Cancel', callback_data: 'cancel' }],
    ]
  );
}

async function rejectState(env: Bindings, connection: TelegramConnection, id: number): Promise<RejectState | null> {
  const session = await getSession(env.DB, connection.telegram_user_id);
  if (session?.flow !== 'reject_submission') return null;
  const state = JSON.parse(session.data_json) as RejectState;
  return state.submissionId === id ? state : null;
}

async function clearRejectSession(env: Bindings, connection: TelegramConnection, id: number): Promise<void> {
  if (await rejectState(env, connection, id)) await clearSession(env.DB, connection.telegram_user_id);
}

async function reject(
  env: Bindings,
  api: TelegramApi,
  connection: TelegramConnection,
  chatId: string,
  id: number,
  reason: string | null,
  cardMessageId: number | undefined
): Promise<void> {
  const submission = await getSubmission(env.DB, id);
  if (!submission) throw new Error('That request no longer exists.');
  await clearRejectSession(env, connection, id);
  if (!(await rejectSubmission(env.DB, id, connection.admin_subject, reason))) {
    return alreadyDecided(api, chatId, id, cardMessageId);
  }
  await clearButtons(api, chatId, cardMessageId);
  const kind = kindLabel(submission.kind);
  await api.sendMessage(
    chatId,
    `❌ Rejected request #${id}. ${reason ? `${esc(submission.display_name)} gets your reason.` : 'No reason was given.'}`
  );
  await tellSubmitter(
    env,
    submission.submitter_chat_id,
    `❌ Your ${kind} request <b>#${id}</b> (${esc(submission.party ?? '')}, ${esc(amountLabel(submission))}) was not approved.${
      reason ? `\n\nReason: ${esc(reason)}` : ''
    }\n\nYou can send a corrected one with /${kind}.`,
    submissionsMenuKeyboard()
  );
  console.log(JSON.stringify({ event: 'submission_rejected', submissionId: id, kind }));
}

async function decideAccess(
  env: Bindings,
  api: TelegramApi,
  connection: TelegramConnection,
  chatId: string,
  id: number,
  action: string,
  messageId: number | undefined
): Promise<void> {
  const submitter = await getSubmitterById(env.DB, id);
  if (!submitter) throw new Error('That person no longer exists.');
  const admin = connection.admin_subject;
  let changed = false;
  let adminText = '';
  let submitterText = '';
  let keyboard: InlineKeyboard | undefined;
  if (action === 'suballow') {
    changed = await setSubmitterStatus(env.DB, id, 'active', ['pending', 'denied', 'revoked'], admin);
    adminText = `✅ ${who(submitter)} can now send expense and income requests.`;
    submitterText = '✅ The admin gave you access. Send an expense or income here whenever you need to.';
    keyboard = submissionsMenuKeyboard();
  } else if (action === 'subdeny') {
    changed = await setSubmitterStatus(env.DB, id, 'denied', ['pending'], admin);
    adminText = `🚫 Denied access for ${who(submitter)}.`;
    submitterText = 'The admin declined your access request.';
  } else if (action === 'subrevoke') {
    changed = await setSubmitterStatus(env.DB, id, 'revoked', ['active'], admin);
    if (changed) await deleteDraft(env.DB, id);
    adminText = `🚫 Removed access for ${who(submitter)}. Requests they already sent stay in /pending.`;
    submitterText = 'Your access to this bot was removed.';
  }
  await clearButtons(api, chatId, messageId);
  if (!changed) {
    await api.sendMessage(chatId, `Nothing changed: ${who(submitter)} already has that status. Send /submitters to check.`);
    return;
  }
  await api.sendMessage(chatId, adminText);
  await tellSubmitter(env, submitter.telegram_chat_id, submitterText, keyboard);
  console.log(JSON.stringify({ event: 'submitter_access_changed', submitterId: id, action }));
}
