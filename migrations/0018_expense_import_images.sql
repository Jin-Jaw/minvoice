-- Allow receipt photos (JPG/PNG/WebP) in review-first expense imports, not
-- only PDFs. SQLite cannot alter a CHECK constraint, so the short-lived
-- staging table is rebuilt; any pending imports are carried across.
CREATE TABLE expense_invoice_imports_v2 (
  token TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1572864),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

INSERT INTO expense_invoice_imports_v2 (token, bytes, mime, filename, size_bytes, sha256, created_at, expires_at)
  SELECT token, bytes, mime, filename, size_bytes, sha256, created_at, expires_at FROM expense_invoice_imports;

DROP TABLE expense_invoice_imports;
ALTER TABLE expense_invoice_imports_v2 RENAME TO expense_invoice_imports;

CREATE INDEX idx_expense_invoice_imports_expiry ON expense_invoice_imports(expires_at);
