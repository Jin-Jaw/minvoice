-- Save the currency that belongs to each client's default rate. Existing
-- clients inherit their most recently used supported invoice currency.
ALTER TABLE clients ADD COLUMN default_currency TEXT
  CHECK (default_currency IN ('USD', 'GBP', 'EUR'));

UPDATE clients
SET default_currency = COALESCE(
  (
    SELECT i.currency
    FROM invoices i
    WHERE i.client_id = clients.id
      AND i.currency IN ('USD', 'GBP', 'EUR')
    ORDER BY i.issue_date DESC, i.created_at DESC, i.id DESC
    LIMIT 1
  ),
  (
    SELECT CASE
      WHEN b.currency IN ('USD', 'GBP', 'EUR') THEN b.currency
      ELSE NULL
    END
    FROM branches b
    WHERE b.id = 1
  ),
  'GBP'
);
