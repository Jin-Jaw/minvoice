-- Money received without an invoice (e.g. rent in Property / Flats). Counted
-- as "received" in reports. Recovered from the production schema on
-- 2026-09-23 (applied 2026-09-21, file never committed).
CREATE TABLE income_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  payer TEXT NOT NULL,
  income_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT
);
CREATE INDEX idx_income_entries_branch_date
  ON income_entries(branch_id, income_date DESC, id DESC);
CREATE INDEX idx_income_entries_client
  ON income_entries(client_id, income_date DESC);
