-- Preserve today's familiar alphabetical order, then allow the admin to
-- explicitly arrange clients. New clients are appended to the end.
ALTER TABLE clients ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY name COLLATE NOCASE, id) - 1 AS position
  FROM clients
)
UPDATE clients
SET sort_order = (SELECT position FROM ranked WHERE ranked.id = clients.id);

CREATE INDEX idx_clients_sort_order ON clients(sort_order, id);
