-- Telegram bot. Recovered from the production schema on 2026-09-23: this
-- migration was applied on 2026-09-21 but its file was never committed.
-- Link tokens are stored hashed; sessions, processed updates and rate-limit
-- windows are short-lived and purged by the daily cron.
CREATE TABLE telegram_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  admin_subject TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL,
  telegram_username TEXT,
  personal_notifications INTEGER NOT NULL DEFAULT 1 CHECK (personal_notifications IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (branch_id, admin_subject)
);
CREATE INDEX idx_telegram_connections_branch ON telegram_connections(branch_id);

CREATE TABLE telegram_link_tokens (
  token_hash TEXT PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  admin_subject TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE telegram_sessions (
  telegram_user_id TEXT PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  flow TEXT NOT NULL,
  step TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_telegram_sessions_expiry ON telegram_sessions(expires_at);

CREATE TABLE telegram_processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE telegram_rate_limits (
  telegram_user_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (telegram_user_id, window_start)
);

CREATE TABLE telegram_notification_log (
  connection_id INTEGER NOT NULL REFERENCES telegram_connections(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection_id, event_key)
);

-- Supporting files attached to outgoing invoices from Telegram; emailed with the invoice.
CREATE TABLE invoice_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'application/pdf')),
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  sha256 TEXT NOT NULL,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  uploaded_by_telegram_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (invoice_id, sha256)
);
CREATE INDEX idx_invoice_attachments_invoice ON invoice_attachments(invoice_id);
