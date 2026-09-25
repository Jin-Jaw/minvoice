// D1 access for the submissions bot: submitters, draft and pending requests,
// and the approve and reject writes that move a request into the ledger.

import type { Branch } from '../../db/queries';

/** Requests from the submissions bot are always filed under this workspace. */
export const SUBMISSIONS_WORKSPACE_SLUG = 'jinjaw-arabia';

export type SubmitterStatus = 'pending' | 'active' | 'denied' | 'revoked';

export type Submitter = {
  id: number;
  telegram_user_id: string;
  telegram_chat_id: string;
  telegram_username: string | null;
  display_name: string;
  status: SubmitterStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  last_used_at: string | null;
};

export type SubmissionKind = 'expense' | 'income';
export type SubmissionStatus = 'draft' | 'pending' | 'approved' | 'rejected';

export type Submission = {
  id: number;
  submitter_id: number;
  branch_id: number;
  kind: SubmissionKind | null;
  status: SubmissionStatus;
  step: string | null;
  party: string | null;
  entry_date: string | null;
  amount_cents: number | null;
  tax_cents: number;
  currency: string | null;
  category: string | null;
  reference: string | null;
  note: string | null;
  file_mime: string | null;
  file_name: string | null;
  file_size: number | null;
  file_sha256: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  expense_id: number | null;
  income_id: number | null;
};

export type SubmissionWithSubmitter = Submission & {
  display_name: string;
  telegram_username: string | null;
  submitter_chat_id: string;
};

export type SubmissionFile = { bytes: Uint8Array; mime: string; filename: string; size_bytes: number; sha256: string };

/** The fields a submitter can change on a draft. */
export type DraftPatch = Partial<
  Pick<
    Submission,
    'kind' | 'step' | 'party' | 'entry_date' | 'amount_cents' | 'tax_cents' | 'currency' | 'category' | 'reference' | 'note'
  >
>;

const DRAFT_COLUMNS: readonly (keyof DraftPatch)[] = [
  'kind',
  'step',
  'party',
  'entry_date',
  'amount_cents',
  'tax_cents',
  'currency',
  'category',
  'reference',
  'note',
];

// Every column except the file bytes, which are only read when needed.
const COLUMNS = `s.id, s.submitter_id, s.branch_id, s.kind, s.status, s.step, s.party, s.entry_date, s.amount_cents,
  s.tax_cents, s.currency, s.category, s.reference, s.note, s.file_mime, s.file_name, s.file_size, s.file_sha256,
  s.created_at, s.updated_at, s.submitted_at, s.decided_at, s.decided_by, s.decision_note, s.expense_id, s.income_id`;

/** The company requests are filed under: the first active company in the Arabia workspace. */
export function getSubmissionsBranch(db: D1Database): Promise<Branch | null> {
  return db
    .prepare(
      `SELECT b.* FROM branches b JOIN workspaces w ON w.id = b.workspace_id
       WHERE w.slug = ? AND b.active = 1 ORDER BY b.id LIMIT 1`
    )
    .bind(SUBMISSIONS_WORKSPACE_SLUG)
    .first<Branch>();
}

/** Telegram retries deliveries; each update_id is processed at most once. */
export async function claimSubmissionsUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO submissions_bot_updates (update_id) VALUES (?)')
    .bind(updateId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

// ---------- Submitters ----------

export function getSubmitter(db: D1Database, userId: string): Promise<Submitter | null> {
  return db.prepare('SELECT * FROM telegram_submitters WHERE telegram_user_id = ?').bind(userId).first<Submitter>();
}

export function getSubmitterById(db: D1Database, id: number): Promise<Submitter | null> {
  return db.prepare('SELECT * FROM telegram_submitters WHERE id = ?').bind(id).first<Submitter>();
}

/** Records a first contact as a pending access request. Null when the account already has a row. */
export async function requestAccess(
  db: D1Database,
  input: { userId: string; chatId: string; username: string | null; displayName: string }
): Promise<Submitter | null> {
  return db
    .prepare(
      `INSERT INTO telegram_submitters (telegram_user_id, telegram_chat_id, telegram_username, display_name)
       VALUES (?, ?, ?, ?) ON CONFLICT (telegram_user_id) DO NOTHING RETURNING *`
    )
    .bind(input.userId, input.chatId, input.username, input.displayName)
    .first<Submitter>();
}

export async function touchSubmitter(
  db: D1Database,
  userId: string,
  chatId: string,
  username: string | null,
  displayName: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_submitters SET telegram_chat_id = ?, telegram_username = ?, display_name = ?,
       last_used_at = datetime('now') WHERE telegram_user_id = ?`
    )
    .bind(chatId, username, displayName, userId)
    .run();
}

/** Moves a submitter to `status` only from one of `from`; false when nothing changed. */
export async function setSubmitterStatus(
  db: D1Database,
  id: number,
  status: SubmitterStatus,
  from: SubmitterStatus[],
  adminSubject: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE telegram_submitters SET status = ?, decided_at = datetime('now'), decided_by = ?
       WHERE id = ? AND status IN (SELECT value FROM json_each(?))`
    )
    .bind(status, adminSubject, id, JSON.stringify(from))
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Pending requests first, then active submitters, then everyone else. */
export async function listSubmitters(db: D1Database, limit = 20): Promise<Submitter[]> {
  return (
    await db
      .prepare(
        `SELECT * FROM telegram_submitters
         ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, display_name COLLATE NOCASE
         LIMIT ?`
      )
      .bind(limit)
      .all<Submitter>()
  ).results;
}

// ---------- Drafts ----------

export function getDraft(db: D1Database, submitterId: number): Promise<Submission | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM submissions s WHERE s.submitter_id = ? AND s.status = 'draft'`)
    .bind(submitterId)
    .first<Submission>();
}

/** Starts a new draft, replacing any draft the submitter had. */
export async function createDraft(
  db: D1Database,
  submitterId: number,
  branchId: number,
  patch: DraftPatch
): Promise<Submission> {
  const columns = DRAFT_COLUMNS.filter((column) => patch[column] !== undefined);
  await db.batch([
    db.prepare("DELETE FROM submissions WHERE submitter_id = ? AND status = 'draft'").bind(submitterId),
    db
      .prepare(
        `INSERT INTO submissions (submitter_id, branch_id${columns.map((column) => `, ${column}`).join('')})
         VALUES (?, ?${columns.map(() => ', ?').join('')})`
      )
      .bind(submitterId, branchId, ...columns.map((column) => patch[column] ?? null)),
  ]);
  const draft = await getDraft(db, submitterId);
  if (!draft) throw new Error('I couldn’t start that request. Please try again.');
  return draft;
}

export async function updateDraft(db: D1Database, draft: Submission, patch: DraftPatch): Promise<Submission> {
  const columns = DRAFT_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length) {
    await db
      .prepare(
        `UPDATE submissions SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = datetime('now')
         WHERE id = ? AND submitter_id = ? AND status = 'draft'`
      )
      .bind(...columns.map((column) => patch[column] ?? null), draft.id, draft.submitter_id)
      .run();
  }
  const updated = await getDraft(db, draft.submitter_id);
  if (!updated || updated.id !== draft.id) throw new Error('That request expired. Start again with /expense or /income.');
  return updated;
}

export async function setDraftFile(db: D1Database, draft: Submission, file: SubmissionFile): Promise<Submission> {
  await db
    .prepare(
      `UPDATE submissions SET file_bytes = ?, file_mime = ?, file_name = ?, file_size = ?, file_sha256 = ?,
       updated_at = datetime('now') WHERE id = ? AND submitter_id = ? AND status = 'draft'`
    )
    .bind(file.bytes, file.mime, file.filename, file.size_bytes, file.sha256, draft.id, draft.submitter_id)
    .run();
  return updateDraft(db, draft, {});
}

export async function deleteDraft(db: D1Database, submitterId: number): Promise<void> {
  await db.prepare("DELETE FROM submissions WHERE submitter_id = ? AND status = 'draft'").bind(submitterId).run();
}

/** Sends a complete draft for approval; false when a required field is missing. */
export async function submitDraft(db: D1Database, draft: Submission): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE submissions SET status = 'pending', step = NULL, submitted_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND submitter_id = ? AND status = 'draft' AND kind IS NOT NULL AND party IS NOT NULL
         AND entry_date IS NOT NULL AND amount_cents IS NOT NULL AND currency IS NOT NULL`
    )
    .bind(draft.id, draft.submitter_id)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

// ---------- Requests ----------

export function getSubmission(db: D1Database, id: number): Promise<SubmissionWithSubmitter | null> {
  return db
    .prepare(
      `SELECT ${COLUMNS}, t.display_name, t.telegram_username, t.telegram_chat_id AS submitter_chat_id
       FROM submissions s JOIN telegram_submitters t ON t.id = s.submitter_id
       WHERE s.id = ? AND s.status != 'draft'`
    )
    .bind(id)
    .first<SubmissionWithSubmitter>();
}

export async function getSubmissionFile(db: D1Database, id: number): Promise<SubmissionFile | null> {
  const row = await db
    .prepare(
      `SELECT file_bytes, file_mime, file_name, file_size, file_sha256 FROM submissions
       WHERE id = ? AND file_bytes IS NOT NULL`
    )
    .bind(id)
    .first<{ file_bytes: ArrayBuffer | number[]; file_mime: string; file_name: string; file_size: number; file_sha256: string }>();
  if (!row) return null;
  return {
    bytes: row.file_bytes instanceof ArrayBuffer ? new Uint8Array(row.file_bytes) : Uint8Array.from(row.file_bytes),
    mime: row.file_mime,
    filename: row.file_name,
    size_bytes: row.file_size,
    sha256: row.file_sha256,
  };
}

/** Oldest first, so the admin works through them in order. */
export async function listPendingSubmissions(db: D1Database, limit = 10): Promise<SubmissionWithSubmitter[]> {
  return (
    await db
      .prepare(
        `SELECT ${COLUMNS}, t.display_name, t.telegram_username, t.telegram_chat_id AS submitter_chat_id
         FROM submissions s JOIN telegram_submitters t ON t.id = s.submitter_id
         WHERE s.status = 'pending' ORDER BY s.id LIMIT ?`
      )
      .bind(limit)
      .all<SubmissionWithSubmitter>()
  ).results;
}

export async function listSubmitterRequests(db: D1Database, submitterId: number, limit = 10): Promise<Submission[]> {
  return (
    await db
      .prepare(`SELECT ${COLUMNS} FROM submissions s WHERE s.submitter_id = ? AND s.status != 'draft' ORDER BY s.id DESC LIMIT ?`)
      .bind(submitterId, limit)
      .all<Submission>()
  ).results;
}

/**
 * Approving writes the expense or income entry, marks the request approved
 * and moves its file to the entry's evidence, all in one D1 batch. The batch
 * is a single transaction, so its statements see each other's
 * last_insert_rowid() and changes(). The UPDATE only claims the request when
 * the INSERT above it wrote a row, so a double tap writes one entry. Returns
 * the new entry id, or null when the request was no longer pending.
 */
export async function approveSubmission(
  db: D1Database,
  submission: SubmissionWithSubmitter,
  adminSubject: string,
  text: string
): Promise<number | null> {
  const id = submission.id;
  const statements =
    submission.kind === 'income'
      ? [
          db
            .prepare(
              `INSERT INTO income_entries (branch_id, client_id, payer, income_date, amount_cents, currency, reference)
               SELECT s.branch_id,
                 (SELECT c.id FROM clients c JOIN client_branches cb ON cb.client_id = c.id
                  WHERE cb.branch_id = s.branch_id AND c.archived = 0 AND c.name = s.party COLLATE NOCASE
                  ORDER BY c.id LIMIT 1),
                 s.party, s.entry_date, s.amount_cents, s.currency, ?2
               FROM submissions s WHERE s.id = ?1 AND s.status = 'pending' AND s.kind = 'income'`
            )
            .bind(id, text),
          db
            .prepare(
              `UPDATE submissions SET status = 'approved', income_id = last_insert_rowid(), decided_at = datetime('now'),
               decided_by = ?2, updated_at = datetime('now')
               WHERE id = ?1 AND status = 'pending' AND changes() = 1`
            )
            .bind(id, adminSubject),
          db
            .prepare(
              `INSERT OR IGNORE INTO income_attachments (income_id, bytes, mime, filename, size_bytes, sha256)
               SELECT income_id, file_bytes, file_mime, file_name, file_size, file_sha256 FROM submissions
               WHERE id = ? AND status = 'approved' AND income_id IS NOT NULL AND file_bytes IS NOT NULL`
            )
            .bind(id),
        ]
      : [
          db
            .prepare(
              `INSERT INTO expenses
               (branch_id, client_id, expense_date, payee, category, description, reference, amount_cents, tax_cents, currency)
               SELECT branch_id, NULL, entry_date, party, COALESCE(category, 'Other'), ?2, reference, amount_cents,
                 MIN(tax_cents, amount_cents), currency
               FROM submissions WHERE id = ?1 AND status = 'pending' AND kind = 'expense'`
            )
            .bind(id, text),
          db
            .prepare(
              `UPDATE submissions SET status = 'approved', expense_id = last_insert_rowid(), decided_at = datetime('now'),
               decided_by = ?2, updated_at = datetime('now')
               WHERE id = ?1 AND status = 'pending' AND changes() = 1`
            )
            .bind(id, adminSubject),
          db
            .prepare(
              `INSERT OR IGNORE INTO expense_attachments (expense_id, bytes, mime, filename, size_bytes, sha256)
               SELECT expense_id, file_bytes, file_mime, file_name, file_size, file_sha256 FROM submissions
               WHERE id = ? AND status = 'approved' AND expense_id IS NOT NULL AND file_bytes IS NOT NULL`
            )
            .bind(id),
        ];
  // The evidence now lives on the entry; drop the request's copy.
  statements.push(
    db
      .prepare(
        `UPDATE submissions SET file_bytes = NULL
         WHERE id = ? AND status = 'approved' AND COALESCE(expense_id, income_id) IS NOT NULL`
      )
      .bind(id)
  );
  const results = await db.batch(statements);
  if ((results[1].meta.changes ?? 0) !== 1) return null;
  const row = await db
    .prepare('SELECT COALESCE(expense_id, income_id) AS entry_id FROM submissions WHERE id = ?')
    .bind(id)
    .first<{ entry_id: number | null }>();
  return row?.entry_id ?? null;
}

/** False when the request was no longer pending. */
export async function rejectSubmission(
  db: D1Database,
  id: number,
  adminSubject: string,
  reason: string | null
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE submissions SET status = 'rejected', decided_at = datetime('now'), decided_by = ?, decision_note = ?,
       updated_at = datetime('now') WHERE id = ? AND status = 'pending'`
    )
    .bind(adminSubject, reason, id)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Daily housekeeping (cron): abandoned drafts after a day, processed update
 * ids after a week, and the files of rejected requests after 30 days.
 */
export async function purgeSubmissionsData(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM submissions WHERE status = 'draft' AND updated_at < datetime('now', '-1 day')"),
    db.prepare("DELETE FROM submissions_bot_updates WHERE processed_at < datetime('now', '-7 days')"),
    db.prepare(
      `UPDATE submissions SET file_bytes = NULL
       WHERE status = 'rejected' AND file_bytes IS NOT NULL AND decided_at < datetime('now', '-30 days')`
    ),
  ]);
}
