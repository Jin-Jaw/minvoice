# Jin&Jaw invoices operations

This is Jin&Jaw's private accounting fork of
[Minvoice](https://github.com/ddyy/minvoice). It runs as a separate Cloudflare
Worker at `https://invoices.jin-jaw.co.uk` and stores clients, invoices,
payments, expenses, private expense evidence, events, workspaces, and configuration in the
`jinjaw-invoices-eu` D1 database (binding `DB`, created in the EU jurisdiction).

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
to 1.5 MB each. Drop evidence directly onto an expense row or the expense detail
page. Expenses without evidence are explicitly flagged **Missing invoice**.
The Reports page can export a ZIP containing `expenses.csv` and every evidence
file; paths inside the ZIP are recorded in the CSV. Never commit exported
evidence or database backups.

## Workspaces

Use the selector at the top left to move between **Jin&Jaw invoices** and
**Property / Flats**. Companies, clients, invoices, payments, expenses, and
reports are scoped to the selected workspace. Property / Flats starts with an
empty ledger and a default property company shell that can be renamed in
Companies or Settings.

## Telegram bot

The bot runs inside the same `jinjaw-invoices` Worker; there is no separate
service. Telegram delivers updates to
`POST https://invoices.jin-jaw.co.uk/api/integrations/telegram/webhook`, and
the Worker rejects any request whose `X-Telegram-Bot-Api-Secret-Token` header
does not match `TELEGRAM_WEBHOOK_SECRET`.

- **Secrets** (Worker secrets, never in git): `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`. Settings → Telegram shows
  a warning until all three exist.
- **Linking:** Settings → Telegram → "Open Telegram app & connect" creates a
  one-time `/start` token (10 minutes, stored hashed). The connection binds
  the signed-in admin to one Telegram account and to the active company;
  `/workspace` in the bot switches company.
- **Receipt OCR:** photos sent to `/uploadinvoice` are read by Workers AI
  (`AI` binding, model `@cf/meta/llama-4-scout-17b-16e-instruct`, in
  `src/services/receipt-ocr.ts`). The result is only a suggestion; the user
  always confirms or corrects the amount. A failed model call falls back to
  asking for the amount.
- **Cron:** the daily 15:00 UTC trigger also sends overdue-invoice messages
  and purges expired Telegram sessions, link tokens, processed update ids and
  rate-limit rows.
- **Code:** `src/services/telegram/` (`handler.ts` holds the flows, `api.ts`
  the Bot API client, `repository.ts` the D1 access, `notifications.ts` the
  paid and overdue messages), `src/lib/telegram-input.ts` (line-item and
  amount parsing), and `test/telegram.integration.test.ts`, which drives the
  flows end to end against a test D1.

What the bot does:

| Command | Flow |
| --- | --- |
| `/newinvoice` | Pick or add a client → optional "Repeat last invoice" → currency buttons → lines as `description - price` or `description - 3 x 450` (running subtotal, undo) → due-date buttons → saved payment details → summary where lines, invoice date, due date, tax and payment details can each be changed → create. |
| `/invoices`, `/drafts`, `/unpaid`, `/overdue` | Up to 10 invoices; each offers View, PDF, Attach files, Send (emails client and owner with attachments), Mark paid (today, yesterday or a typed date). |
| `/uploadinvoice` | A PDF (text extraction) or a receipt photo (OCR) → confirm or change amount, date, category, client and paying company → saved as an expense with the file as evidence. PDFs are filed under the company they were billed to. |
| `/income` | Property / Flats only: money received without an invoice (`income_entries`), counted as "received" in reports. |
| `/workspace` | Switch the company the bot acts for. |

Property / Flats (company 3, workspace 2) has `invoicing_enabled = 0`, so the
bot offers only expenses and income there. The bot lists clients per company
through `client_branches`, while the web app lists them per workspace through
`clients.workspace_id`. Creating a client or invoice in either place keeps
both in step.

The Telegram work (migrations `0015_telegram`, `0016_workspace_scoping` and
`0017_direct_income`) was first deployed on 2026-09-21 from a checkout that was
never pushed. On 2026-09-23 it was rebuilt from the deployed bundle and the
production schema, and merged into `main` with the workspaces feature. Deploy
only through CI from `main`, so production never again runs code that git
does not have.

## Backups and recovery

Run `npm run db:backup:prod` regularly and copy the resulting gitignored SQL
file from `backups/` into Jin&Jaw's encrypted business backup location. Always
take a fresh export before deploying migrations or making a large import.

Cloudflare D1 Time Travel covers recent point-in-time recovery. SQL exports are
the independent, longer-retention copy. Never commit an export: it contains
client and financial data.

## Routine maintenance

Every push to `main` runs type-checking, tests, and a Worker dry run in GitHub
Actions. Production deploys only after all three checks pass. The deploy job
applies pending D1 migrations, publishes the Worker, and verifies that the
settings encryption key exists. GitHub stores the Cloudflare credentials as
the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` repository secrets;
never add either value to the repository.

- `npm ci` — install the audited lockfile.
- `npm test` — run the unit and D1 integration suite.
- `npm run typecheck` — type-check Worker and tests.
- `npm run deploy:dry-run` — validate the production bundle without deploying.
- `npm run deploy` — migrate D1 and deploy the Worker.
- `npm run db:backup:prod` — export a timestamped production snapshot.
- `npx wrangler tail jinjaw-invoices` — inspect live structured Worker logs.

Before a large change, compare `npx wrangler d1 migrations list DB --remote`
with `migrations/`: the list must be empty or show only your new files.

On Windows, `wrangler dev` and the D1 integration tests cannot run locally
(workerd fails to start), so CI is the place those tests run. The unit tests
(`npx vitest run --project unit`) and the type check work locally.

Do not rotate or delete `SETTINGS_MASTER_KEY` without first removing or
re-entering any API credentials stored through the app. Wrangler secrets take
precedence and are the preferred place for payment and email credentials.
