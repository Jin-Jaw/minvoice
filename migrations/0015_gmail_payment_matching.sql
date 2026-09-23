-- Optional Gmail payment-confirmation reader. OAuth refresh tokens are stored
-- envelope-encrypted with SETTINGS_MASTER_KEY; message ids are retained for
-- idempotency and audit without storing email bodies.
ALTER TABLE settings ADD COLUMN gmail_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN gmail_refresh_token TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN gmail_address TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN gmail_query TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN gmail_last_checked_at TEXT;

CREATE TABLE gmail_payment_events (
  message_id TEXT PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id),
  result TEXT NOT NULL CHECK (result IN ('paid', 'ignored', 'review')),
  detail TEXT NOT NULL,
  message_date TEXT,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_gmail_payment_events_invoice ON gmail_payment_events(invoice_id, processed_at DESC);
