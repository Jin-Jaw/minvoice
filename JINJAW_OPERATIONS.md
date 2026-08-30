# Jin&Jaw invoices operations

This is Jin&Jaw's private, single-business fork of
[Minvoice](https://github.com/ddyy/minvoice). It runs as a separate Cloudflare
Worker at `https://invoices.jin-jaw.co.uk` and stores clients, invoices,
payments, expenses, private expense evidence, events, and configuration in the
`jinjaw-invoices` D1 database.

## First production deployment

1. Authenticate Wrangler: `npx wrangler login`.
2. Create the database: `npx wrangler d1 create jinjaw-invoices`.
3. Put the returned `database_id` in `wrangler.jsonc` without changing the
   binding or database name.
4. Generate bindings: `npm run types`.
5. Cloudflare Access protects `/admin` with one-time-code sign-in for the
   authorised Jin&Jaw account. Keep `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
   aligned with the `Jin&Jaw Invoices Admin` Access application.
6. Run `npm run deploy`. This applies migrations before deployment and creates
   `SETTINGS_MASTER_KEY` for credentials saved through Settings.
7. Open `/admin`, confirm the registered address, tax position, invoice terms,
   and default rate, then finish the first-run wizard.

Stripe and PayPal are disabled by default. Enable them only after their secrets
and verified webhooks have been configured. Resend is the default email path;
set `RESEND_API_KEY` as a Wrangler secret and use a verified Jin&Jaw sender.

## Historical invoices

Create historical invoices with their original issue and due dates. Mark each
as sent, then record the original payment date as a manual payment where
appropriate. This preserves the invoice, client, status, payment, and activity
timeline in the same ledger as new invoices. Keep original source PDFs in the
company's document archive; generated invoice PDFs can always be downloaded
from the invoice detail page.

## Expenses and evidence

Record paid supplier bills, employee or contractor costs under **Expenses**.
Choose the paying company and currency; optionally assign a related client so
the cost appears in that client's filtered report. Voiding preserves the row
and evidence for audit history while removing the amount from report totals.

Evidence files are private admin downloads stored in D1 and included in the
normal SQL backup. Accepted files are genuine PDF, JPG, PNG, or WebP bytes, up
to 1.5 MB each. Upload additional pages one at a time from the expense detail
page. Never commit exported evidence or database backups.

## Backups and recovery

Run `npm run db:backup:prod` regularly and copy the resulting gitignored SQL
file from `backups/` into Jin&Jaw's encrypted business backup location. Always
take a fresh export before deploying migrations or making a large import.

Cloudflare D1 Time Travel covers recent point-in-time recovery. SQL exports are
the independent, longer-retention copy. Never commit an export: it contains
client and financial data.

## Routine maintenance

- `npm ci` — install the audited lockfile.
- `npm test` — run the unit and D1 integration suite.
- `npm run typecheck` — type-check Worker and tests.
- `npm run deploy:dry-run` — validate the production bundle without deploying.
- `npm run deploy` — migrate D1 and deploy the Worker.
- `npm run db:backup:prod` — export a timestamped production snapshot.
- `npx wrangler tail jinjaw-invoices` — inspect live structured Worker logs.

Do not rotate or delete `SETTINGS_MASTER_KEY` without first removing or
re-entering any API credentials stored through the app. Wrangler secrets take
precedence and are the preferred place for payment and email credentials.
