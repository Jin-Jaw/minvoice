-- Independent accounting workspaces. Existing production data remains in
-- workspace 1; workspace 2 starts with only a default company shell so users
-- can immediately record property income and costs without mixing ledgers.
CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO workspaces (id, name, slug) VALUES
  (1, 'Jin&Jaw invoices', 'jinjaw'),
  (2, 'Property / Flats', 'property-flats');

ALTER TABLE branches ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id);
UPDATE branches SET workspace_id = 1 WHERE workspace_id IS NULL;
CREATE INDEX idx_branches_workspace ON branches(workspace_id, active, id);

ALTER TABLE clients ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id);
UPDATE clients SET workspace_id = 1 WHERE workspace_id IS NULL;
CREATE INDEX idx_clients_workspace ON clients(workspace_id, archived, sort_order, id);

INSERT INTO branches (
  name, business_address, business_email, logo_url, currency, invoice_prefix,
  next_invoice_number, accent_color, default_payment_details, active, workspace_id
) VALUES (
  'Property / Flats', '', NULL, NULL, 'GBP', 'PROP-', 1, '#315f73', '', 1, 2
);
