-- Factory reset: wipe all data AND restore settings to defaults, which
-- re-arms the first-launch setup wizard on the next /admin visit.
-- Usage: npm run db:reset:local | db:reset:test | db:reset:prod

DELETE FROM invoice_events;
DELETE FROM payments;
DELETE FROM webhook_events;
DELETE FROM email_outbox;
DELETE FROM invoice_items;
DELETE FROM invoices;
DELETE FROM clients;
DELETE FROM branch_logos;
DELETE FROM logo;
DELETE FROM branches WHERE id != 1;
DELETE FROM sqlite_sequence
WHERE name IN ('invoice_events', 'payments', 'webhook_events', 'email_outbox', 'invoice_items', 'invoices', 'clients', 'branches');

UPDATE branches SET
  name = '',
  business_address = '',
  business_email = NULL,
  logo_url = NULL,
  currency = 'USD',
  invoice_prefix = 'INV-',
  next_invoice_number = 1,
  accent_color = '#1e5b43',
  active = 1
WHERE id = 1;

UPDATE settings SET
  business_name = '',
  business_address = '',
  business_email = NULL,
  logo_url = NULL,
  currency = 'USD',
  tax_rate_bps = 0,
  invoice_prefix = 'INV-',
  next_invoice_number = 1,
  default_rate_cents = 0,
  timezone = 'UTC',
  email_provider = 'cloudflare',
  email_from = '',
  payment_terms_days = 0,
  stripe_enabled = 1,
  paypal_enabled = 1,
  stripe_secret_key = '',
  stripe_webhook_secret = '',
  paypal_client_id = '',
  paypal_client_secret = '',
  paypal_webhook_id = '',
  resend_api_key = '',
  paypal_environment = 'live',
  reminders_enabled = 0,
  last_seen_origin = '',
  reminder_schedule = '1, 7, 14',
  locale = 'en',
  accent_color = '#1e5b43',
  setup_complete = 0
WHERE id = 1;
