-- Several receipts sent to the Telegram bot at once (an album, or files sent
-- while one is being reviewed) are staged straight away and reviewed one at a
-- time. queued_for is the Telegram user who still has to review the file, and
-- queued_order the message it came in; both are cleared when its review
-- starts. Queued files expire with the rest of the staging table.
ALTER TABLE expense_invoice_imports ADD COLUMN queued_for TEXT;
ALTER TABLE expense_invoice_imports ADD COLUMN queued_order INTEGER;

CREATE INDEX idx_expense_invoice_imports_queue ON expense_invoice_imports(queued_for, queued_order);
