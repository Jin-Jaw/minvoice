-- Paid business expenses and their supporting evidence. Expense rows are
-- soft-voided so corrections remain auditable; evidence is private and is
-- only served from authenticated admin routes.
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  expense_date TEXT NOT NULL,
  payee TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  reference TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0 AND tax_cents <= amount_cents),
  currency TEXT NOT NULL,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE expense_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1572864),
  sha256 TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (expense_id, sha256)
);

CREATE INDEX idx_expenses_date ON expenses(expense_date DESC, id DESC);
CREATE INDEX idx_expenses_branch_date ON expenses(branch_id, expense_date DESC);
CREATE INDEX idx_expenses_client ON expenses(client_id);
CREATE INDEX idx_expense_attachments_expense ON expense_attachments(expense_id, id);
