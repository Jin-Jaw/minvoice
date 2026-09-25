// Text and buttons shared by the submissions bot and the admin bot's
// approval cards.

import { formatDateHuman } from '../../lib/dates';
import { formatCents } from '../../lib/money';
import type { InlineKeyboard } from '../telegram/api';
import { esc } from '../telegram/util';
import type { Submission, SubmissionKind } from './repository';

export function submissionsMenuKeyboard(): InlineKeyboard {
  return [
    [
      { text: '📤 Add expense', callback_data: 'expense' },
      { text: '📥 Add income', callback_data: 'income' },
    ],
    [{ text: '📋 My requests', callback_data: 'mine' }],
  ];
}

export function kindLabel(kind: SubmissionKind | null): string {
  return kind === 'income' ? 'income' : 'expense';
}

export function partyLabel(kind: SubmissionKind | null): string {
  return kind === 'income' ? 'Received from' : 'Paid to';
}

export function amountLabel(submission: Pick<Submission, 'amount_cents' | 'currency'>): string {
  return submission.amount_cents !== null && submission.currency
    ? formatCents(submission.amount_cents, submission.currency)
    : '';
}

/** The request's details, one per line, as HTML. */
export function submissionLines(submission: Submission, currencyFallback: string): string[] {
  const currency = submission.currency ?? currencyFallback;
  const note = submission.note && submission.note.length > 300 ? `${submission.note.slice(0, 300)}…` : submission.note;
  const lines = [
    `${partyLabel(submission.kind)}: ${esc(submission.party ?? 'Not set')}`,
    `Amount: <b>${submission.amount_cents === null ? 'Not set' : esc(formatCents(submission.amount_cents, currency))}</b>`,
  ];
  if (submission.kind === 'expense' && submission.tax_cents > 0) {
    lines.push(`Tax: ${esc(formatCents(submission.tax_cents, currency))}`);
  }
  lines.push(`Date: ${submission.entry_date ? formatDateHuman(submission.entry_date) : 'Not set'}`);
  if (submission.kind === 'expense') lines.push(`Category: ${esc(submission.category ?? 'Other')}`);
  if (submission.reference) lines.push(`Reference: ${esc(submission.reference)}`);
  lines.push(`Note: ${note ? esc(note) : 'None'}`);
  lines.push(`Invoice: ${submission.file_name ? esc(submission.file_name) : 'None attached'}`);
  return lines;
}
