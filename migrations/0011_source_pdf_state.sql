-- Source-PDF lifecycle. `generated` marks archives the app rendered itself
-- (manually uploaded originals stay 0); `stale` flags archives whose invoice
-- was edited afterwards. The admin UI offers Regenerate only while the archive
-- is an upload or stale, and emailing a stale archive regenerates it first.
ALTER TABLE invoice_source_pdfs ADD COLUMN generated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_source_pdfs ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
