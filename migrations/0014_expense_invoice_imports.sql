-- Short-lived staging for review-first supplier invoice imports. The original
-- PDF does not enter the expense ledger until the admin confirms the extracted
-- fields. Unconfirmed uploads expire and are purged automatically.
CREATE TABLE expense_invoice_imports (
  token TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  mime TEXT NOT NULL CHECK (mime = 'application/pdf'),
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1572864),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_expense_invoice_imports_expiry ON expense_invoice_imports(expires_at);
