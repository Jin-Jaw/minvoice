-- Preserve the exact PDF originally issued for imported/historical invoices.
CREATE TABLE invoice_source_pdfs (
  invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/pdf' CHECK (mime = 'application/pdf'),
  filename TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
