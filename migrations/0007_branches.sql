-- Multiple invoice branches with shared clients and shared provider/email
-- configuration. Existing records and branding become branch 1.
CREATE TABLE branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  business_address TEXT NOT NULL DEFAULT '',
  business_email TEXT,
  logo_url TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  invoice_prefix TEXT NOT NULL DEFAULT 'INV-',
  next_invoice_number INTEGER NOT NULL DEFAULT 1,
  accent_color TEXT NOT NULL DEFAULT '#1e5b43',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO branches (
  id, name, business_address, business_email, logo_url, currency,
  invoice_prefix, next_invoice_number, accent_color
)
SELECT
  1,
  COALESCE(NULLIF(business_name, ''), 'Jin&Jaw LTD'),
  business_address,
  business_email,
  logo_url,
  currency,
  invoice_prefix,
  next_invoice_number,
  accent_color
FROM settings WHERE id = 1;

CREATE TABLE branch_logos (
  branch_id INTEGER PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO branch_logos (branch_id, bytes, mime, updated_at)
SELECT 1, bytes, mime, updated_at FROM logo WHERE id = 1;

-- Rebuild the invoice tables so invoice numbers are unique per branch rather
-- than globally. IDs are preserved, so existing outbox payloads remain valid.
CREATE TABLE invoices_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id),
  number TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  currency TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  subject TEXT,
  notes TEXT,
  tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  public_token TEXT NOT NULL UNIQUE,
  paypal_order_id TEXT,
  sent_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (branch_id, number)
);

INSERT INTO invoices_v2 (
  id, branch_id, number, client_id, status, currency, issue_date, due_date,
  subject, notes, tax_rate_bps, subtotal_cents, tax_cents, total_cents,
  public_token, paypal_order_id, sent_at, paid_at, created_at, updated_at
)
SELECT
  id, 1, number, client_id, status, currency, issue_date, due_date,
  subject, notes, tax_rate_bps, subtotal_cents, tax_cents, total_cents,
  public_token, paypal_order_id, sent_at, paid_at, created_at, updated_at
FROM invoices;

CREATE TABLE invoice_items_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices_v2(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
);
INSERT INTO invoice_items_v2 SELECT * FROM invoice_items;

CREATE TABLE payments_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices_v2(id),
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal', 'manual')),
  provider_ref TEXT,
  stripe_payment_intent TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  note TEXT,
  undone_at TEXT,
  recorded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_ref)
);
INSERT INTO payments_v2 SELECT * FROM payments;

CREATE TABLE invoice_events_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices_v2(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO invoice_events_v2 SELECT * FROM invoice_events;

DROP TABLE invoice_items;
DROP TABLE payments;
DROP TABLE invoice_events;
DROP TABLE invoices;

ALTER TABLE invoices_v2 RENAME TO invoices;
ALTER TABLE invoice_items_v2 RENAME TO invoice_items;
ALTER TABLE payments_v2 RENAME TO payments;
ALTER TABLE invoice_events_v2 RENAME TO invoice_events;

CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoices_branch ON invoices(branch_id, id DESC);
CREATE INDEX idx_items_invoice ON invoice_items(invoice_id);
CREATE INDEX idx_events_invoice ON invoice_events(invoice_id);
