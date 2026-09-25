-- Expense and income requests from people who are not admins. They send them
-- through a second Telegram bot (the submissions bot), and nothing reaches
-- the expenses or income ledger until an admin approves the request in the
-- admin bot. Drafts are purged after a day by the daily cron.

-- A Telegram account that asked to use the submissions bot. Only active
-- submitters can send requests; an admin allows or denies each one.
CREATE TABLE telegram_submitters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL,
  telegram_username TEXT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'denied', 'revoked')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT,
  last_used_at TEXT
);

-- One request. While status is 'draft' the submitter is still filling it in
-- and `step` names the reply the bot is waiting for. The evidence file stays
-- here until approval copies it to the expense or income entry.
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submitter_id INTEGER NOT NULL REFERENCES telegram_submitters(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  kind TEXT CHECK (kind IS NULL OR kind IN ('expense', 'income')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  step TEXT,
  -- Expense: the supplier that was paid. Income: whoever paid.
  party TEXT,
  entry_date TEXT,
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  currency TEXT,
  category TEXT,
  reference TEXT,
  note TEXT,
  file_bytes BLOB,
  file_mime TEXT CHECK (file_mime IS NULL OR file_mime IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  file_name TEXT,
  file_size INTEGER CHECK (file_size IS NULL OR (file_size > 0 AND file_size <= 1572864)),
  file_sha256 TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT,
  expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  income_id INTEGER REFERENCES income_entries(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_submissions_one_draft ON submissions(submitter_id) WHERE status = 'draft';
CREATE INDEX idx_submissions_status ON submissions(status, id);
CREATE INDEX idx_submissions_submitter ON submissions(submitter_id, id DESC);

-- Evidence for income entries, the counterpart of expense_attachments.
CREATE TABLE income_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  income_id INTEGER NOT NULL REFERENCES income_entries(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1572864),
  sha256 TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (income_id, sha256)
);
CREATE INDEX idx_income_attachments_income ON income_attachments(income_id, id);

-- Update ids are numbered per bot, so the submissions bot keeps its own
-- de-duplication table instead of sharing telegram_processed_updates.
CREATE TABLE submissions_bot_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
