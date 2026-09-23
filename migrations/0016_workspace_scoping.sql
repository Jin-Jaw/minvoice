-- Per-company client lists and expense-only companies. Recovered from the
-- production schema on 2026-09-23 (applied 2026-09-21, file never committed).
-- The seeding below is a reconstruction: on a fresh database it links each
-- client to every company it has invoiced from, and otherwise to the first
-- company in the client's workspace.
ALTER TABLE branches ADD COLUMN invoicing_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (invoicing_enabled IN (0, 1));

-- Property / Flats (workspace 2) records expenses and direct income only.
UPDATE branches SET invoicing_enabled = 0 WHERE workspace_id = 2;

CREATE TABLE client_branches (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, branch_id)
);
CREATE INDEX idx_client_branches_branch ON client_branches(branch_id, client_id);

INSERT OR IGNORE INTO client_branches (client_id, branch_id)
  SELECT DISTINCT client_id, branch_id FROM invoices;

INSERT OR IGNORE INTO client_branches (client_id, branch_id)
  SELECT c.id, (SELECT b.id FROM branches b WHERE b.workspace_id = COALESCE(c.workspace_id, 1) ORDER BY b.id LIMIT 1)
  FROM clients c
  WHERE NOT EXISTS (SELECT 1 FROM client_branches cb WHERE cb.client_id = c.id)
    AND EXISTS (SELECT 1 FROM branches b WHERE b.workspace_id = COALESCE(c.workspace_id, 1));
