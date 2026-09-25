-- Give Jin&Jaw Arabia S.A.R.L its own workspace, so its clients, invoices,
-- expenses, income and report totals no longer share a ledger with
-- Jin&Jaw Ltd. Company ids stay the same, so invoice numbers, PDF names,
-- Telegram links and company settings carry across unchanged.
--
-- A client used by both companies is copied into the new workspace. The
-- original stays with Jin&Jaw Ltd, and the copy takes over the Arabia
-- invoices, expenses, income and company link. A client used only by Arabia
-- moves across. A database without an Arabia company in workspace 1, such as
-- a new install, is left unchanged.

INSERT INTO workspaces (name, slug)
  SELECT 'Jin&Jaw Arabia', 'jinjaw-arabia'
  WHERE EXISTS (SELECT 1 FROM branches WHERE workspace_id = 1 AND name LIKE 'Jin&Jaw Arabia%')
    AND NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = 'jinjaw-arabia');

-- Workspace 1 now holds only Jin&Jaw Ltd.
UPDATE workspaces SET name = 'Jin&Jaw Ltd'
  WHERE id = 1 AND EXISTS (SELECT 1 FROM workspaces WHERE slug = 'jinjaw-arabia');

-- Working tables, dropped at the end of this migration.
CREATE TABLE arabia_split_branches (id INTEGER PRIMARY KEY);
INSERT INTO arabia_split_branches (id)
  SELECT id FROM branches
  WHERE workspace_id = 1 AND name LIKE 'Jin&Jaw Arabia%'
    AND EXISTS (SELECT 1 FROM workspaces WHERE slug = 'jinjaw-arabia');

CREATE TABLE arabia_split_clients (
  old_id INTEGER PRIMARY KEY,
  new_id INTEGER,
  shared INTEGER NOT NULL
);

-- Every workspace 1 client that Arabia uses, flagged when a company outside
-- Arabia uses it too.
INSERT INTO arabia_split_clients (old_id, shared)
  SELECT c.id,
    EXISTS (SELECT 1 FROM client_branches cb WHERE cb.client_id = c.id AND cb.branch_id NOT IN (SELECT id FROM arabia_split_branches))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.client_id = c.id AND i.branch_id NOT IN (SELECT id FROM arabia_split_branches))
    OR EXISTS (SELECT 1 FROM expenses e WHERE e.client_id = c.id AND e.branch_id NOT IN (SELECT id FROM arabia_split_branches))
    OR EXISTS (SELECT 1 FROM income_entries ie WHERE ie.client_id = c.id AND ie.branch_id NOT IN (SELECT id FROM arabia_split_branches))
  FROM clients c
  WHERE c.workspace_id = 1 AND (
    EXISTS (SELECT 1 FROM client_branches cb WHERE cb.client_id = c.id AND cb.branch_id IN (SELECT id FROM arabia_split_branches))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.client_id = c.id AND i.branch_id IN (SELECT id FROM arabia_split_branches))
    OR EXISTS (SELECT 1 FROM expenses e WHERE e.client_id = c.id AND e.branch_id IN (SELECT id FROM arabia_split_branches))
    OR EXISTS (SELECT 1 FROM income_entries ie WHERE ie.client_id = c.id AND ie.branch_id IN (SELECT id FROM arabia_split_branches))
  );

-- New ids for the copies, above every id the clients table has handed out.
UPDATE arabia_split_clients
  SET new_id = MAX(
      COALESCE((SELECT MAX(id) FROM clients), 0),
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'clients'), 0)
    ) + (SELECT COUNT(*) FROM arabia_split_clients s WHERE s.shared = 1 AND s.old_id <= arabia_split_clients.old_id)
  WHERE shared = 1;

INSERT INTO clients (
  id, workspace_id, name, email, address, archived, default_rate_cents,
  payment_terms_days, created_at, locale, default_currency, sort_order
)
  SELECT s.new_id, w.id, c.name, c.email, c.address, c.archived, c.default_rate_cents,
    c.payment_terms_days, c.created_at, c.locale, c.default_currency, c.sort_order
  FROM arabia_split_clients s
  JOIN clients c ON c.id = s.old_id
  JOIN workspaces w ON w.slug = 'jinjaw-arabia'
  WHERE s.shared = 1;

UPDATE invoices
  SET client_id = (SELECT s.new_id FROM arabia_split_clients s WHERE s.old_id = invoices.client_id)
  WHERE branch_id IN (SELECT id FROM arabia_split_branches)
    AND client_id IN (SELECT old_id FROM arabia_split_clients WHERE shared = 1);

UPDATE expenses
  SET client_id = (SELECT s.new_id FROM arabia_split_clients s WHERE s.old_id = expenses.client_id)
  WHERE branch_id IN (SELECT id FROM arabia_split_branches)
    AND client_id IN (SELECT old_id FROM arabia_split_clients WHERE shared = 1);

UPDATE income_entries
  SET client_id = (SELECT s.new_id FROM arabia_split_clients s WHERE s.old_id = income_entries.client_id)
  WHERE branch_id IN (SELECT id FROM arabia_split_branches)
    AND client_id IN (SELECT old_id FROM arabia_split_clients WHERE shared = 1);

UPDATE client_branches
  SET client_id = (SELECT s.new_id FROM arabia_split_clients s WHERE s.old_id = client_branches.client_id)
  WHERE branch_id IN (SELECT id FROM arabia_split_branches)
    AND client_id IN (SELECT old_id FROM arabia_split_clients WHERE shared = 1);

UPDATE clients
  SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'jinjaw-arabia')
  WHERE id IN (SELECT old_id FROM arabia_split_clients WHERE shared = 0);

UPDATE branches
  SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'jinjaw-arabia')
  WHERE id IN (SELECT id FROM arabia_split_branches);

DROP TABLE arabia_split_clients;
DROP TABLE arabia_split_branches;
