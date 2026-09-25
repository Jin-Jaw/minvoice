# Jin&Jaw invoices operations

This is Jin&Jaw's private accounting fork of
[Minvoice](https://github.com/ddyy/minvoice). It runs as a separate Cloudflare
Worker at `https://invoices.jin-jaw.co.uk` and stores clients, invoices,
payments, expenses, private expense evidence, events, workspaces, and configuration in the
`jinjaw-invoices-eu` D1 database (binding `DB`, created in the EU jurisdiction).

The GitHub repository `Jin-Jaw/minvoice` is public, and must stay public: the
website's Workers Builds clones it as a submodule of the private website
repository, and it cannot clone a private submodule. Never commit client
data, exports, secret values, or the trusted Gmail senders.

## First production deployment

These steps also rebuild production from nothing, for example in a new
Cloudflare account. The rebuild checklist below lists everything outside git
that they depend on.

1. Authenticate Wrangler: `npx wrangler login`.
2. Create the database:
   `npx wrangler d1 create jinjaw-invoices-eu --jurisdiction eu`.
3. Put the returned `database_id` in `wrangler.jsonc` without changing the
   binding or database name.
4. To keep the existing data, import the latest SQL export into the new, empty
   database now, before any deploy (see Backups and recovery).
5. Generate bindings: `npm run types`.
6. Cloudflare Access protects `/admin` with one-time-code sign-in for the
   authorised Jin&Jaw account. Keep `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
   aligned with the `Jin&Jaw Invoices Admin` Access application.
7. Commit the `wrangler.jsonc` change and push to `main`. CI applies the
   migrations, deploys, and creates `SETTINGS_MASTER_KEY` for credentials
   saved through Settings.
8. Set the Telegram secrets and register the webhooks (see Telegram bot and
   Staff submissions bot).
9. Open `/admin`. On an empty database, confirm the registered address, tax
   position, invoice terms, and default rate, then finish the first-run
   wizard. After an import into a new Worker, re-enter the Resend API key in
   Settings → Email and reconnect Gmail in Settings → Gmail payments: the new
   `SETTINGS_MASTER_KEY` cannot decrypt the stored credentials.

Stripe and PayPal are disabled by default. Enable them only after their secrets
and verified webhooks have been configured.

Production sends email through Resend from `contact@jin-jaw.co.uk`, so
`jin-jaw.co.uk` must stay verified at Resend. The Resend API key is saved in
Settings → Email, encrypted with `SETTINGS_MASTER_KEY`. A `RESEND_API_KEY`
Worker secret would take precedence, but production does not set one. The
`EMAIL` binding in `wrangler.jsonc` (Cloudflare Email Sending) is not in use.
A new database's first-run wizard selects it because the binding exists, so
choose Resend in Settings → Email to match production. Switching to Cloudflare
Email Sending needs the domain onboarded under Email Service first.

## Rebuild checklist

Everything production depends on outside git, as of 2026-09-23:

- **Worker secrets:** `SETTINGS_MASTER_KEY` (created by the deploy and
  impossible to read back), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
  `TELEGRAM_WEBHOOK_SECRET`, `SUBMISSIONS_BOT_TOKEN`,
  `SUBMISSIONS_WEBHOOK_SECRET`, `SUBMISSIONS_BOT_USERNAME`, `GMAIL_CLIENT_ID`
  and `GMAIL_CLIENT_SECRET`. `ADMIN_PASSWORD` is not set, because Access handles sign-in. `RESEND_API_KEY`
  is not set, because the key is saved in Settings.
- **Saved in Settings (D1, encrypted with `SETTINGS_MASTER_KEY`):** the Resend
  API key and the Gmail refresh token.
- **Bindings in `wrangler.jsonc`:** `DB` (D1, EU jurisdiction), `AI` (Workers
  AI for receipt OCR), `PDF_RATE_LIMITER`, `EMAIL` and `ASSETS`. `AI` and
  `PDF_RATE_LIMITER` need nothing beyond the deploy.
- **Cloudflare:** the `jin-jaw.co.uk` zone in the same account (the deploy
  attaches the `invoices.jin-jaw.co.uk` custom domain), the
  `Jin&Jaw Invoices Admin` Access application for `/admin`, and a Workers Paid
  plan for 30-day Time Travel. The daily cron trigger deploys from
  `wrangler.jsonc`.
- **Resend:** `jin-jaw.co.uk` verified as a sending domain, and an API key.
- **Google Cloud:** the OAuth web client behind `GMAIL_CLIENT_ID`, with the
  Gmail API enabled and the Gmail callback registered as a redirect URI.
- **Telegram:** the admin bot and the staff submissions bot in BotFather, each
  with its registered webhook.
- **GitHub:** the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` repository
  secrets used by the deploy job.

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

Evidence files are private admin files stored in D1 and included in the
normal SQL backup. Accepted files are genuine PDF, JPG, PNG, or WebP bytes, up
to 1.5 MB each. Drop evidence directly onto an expense row or the expense detail
page. Expenses without evidence are explicitly flagged **Missing invoice**.
The Reports page can export a ZIP containing `expenses.csv` and every evidence
file; paths inside the ZIP are recorded in the CSV. Never commit exported
evidence or database backups.

"View N files" on an expense row, and each file on the expense detail page,
open the evidence viewer. Images show full size on a click; PDFs show in the
browser's PDF reader. Previous and Next move between an expense's files, and
Open and Download stay available. The viewer loads
`/admin/expenses/:id/attachments/:attachmentId/view`, which serves the file
inline. That route and the staged import file are the only responses that
allow same-origin framing (`frame-ancestors 'self'`, `X-Frame-Options:
SAMEORIGIN`, see `src/lib/evidence-preview.ts`); every other response denies
framing. Mobile browsers without a built-in PDF reader need Open or Download.

## Workspaces

Use the selector at the top left to move between **Jin&Jaw Ltd**,
**Property / Flats** and **Jin&Jaw Arabia**. The selector lists the rows of
the `workspaces` table. Companies, clients, invoices, payments, expenses,
income and reports are scoped to the selected workspace, so each workspace's
report totals cover only its own companies. Property / Flats starts with an
empty ledger and a default property company shell that can be renamed in
Companies or Settings.

Migration `0019_arabia_workspace` gave Jin&Jaw Arabia S.A.R.L (company id 2)
its own workspace and renamed workspace 1 from "Jin&Jaw invoices" to
"Jin&Jaw Ltd". Company ids did not change, so invoice numbers, PDF names,
Telegram links and company settings carried across. A client that both
companies had used was copied: the original stayed with Jin&Jaw Ltd and the
copy took over the Arabia invoices, expenses, income and company link. Clients
that only Arabia used moved across. Edit the two copies separately from then
on.

A supplier invoice PDF imported on the web is filed under a company in the
selected workspace. When it names a company from another workspace, the review
page says so: cancel the import and upload it from that workspace. The
Telegram bot searches every company and files it under the named company in
any workspace.

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

### Registering the webhook

Nothing in the code calls `setWebhook`, so Telegram delivers nothing until the
webhook is registered by hand. Register it after the first deploy, after
changing `TELEGRAM_WEBHOOK_SECRET` (until then Telegram sends the old secret
and the Worker answers 403), and after revoking the bot token in BotFather.

The secret may contain only `A-Z`, `a-z`, `0-9`, `_` and `-`, up to 256
characters; `openssl rand -hex 32` produces a suitable value. Store it with
`npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`, then register the same value
from Git Bash:

```bash
read -rs -p 'Bot token: ' TOKEN; echo
read -rs -p 'Webhook secret: ' SECRET; echo
curl -sS "https://api.telegram.org/bot$TOKEN/setWebhook" \
  --data-urlencode "url=https://invoices.jin-jaw.co.uk/api/integrations/telegram/webhook" \
  --data-urlencode "secret_token=$SECRET"
curl -sS "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```

`getWebhookInfo` shows the registered URL, the number of pending updates, and
the last delivery error, if any.

### Stopping the bot

- **One account:** Settings → Telegram → "Disconnect Telegram" deletes the
  signed-in admin's link. The bot then only tells that Telegram account to connect first.
- **All deliveries:** `curl -sS "https://api.telegram.org/bot$TOKEN/deleteWebhook"`,
  with `TOKEN` read as above, stops Telegram sending updates.
- **At the Worker:** `npx wrangler secret delete TELEGRAM_WEBHOOK_SECRET` makes
  the endpoint answer 503 to every delivery. Telegram keeps retrying and
  queues the updates.
- **Leaked bot token:** revoke it with `/revoke` in BotFather, store the new
  token with `npx wrangler secret put TELEGRAM_BOT_TOKEN`, and register the
  webhook again.

To resume after a stop, restore any deleted secret and register the webhook
again with `--data-urlencode "drop_pending_updates=true"` added, so queued
commands are not replayed.

### What the bot does

| Command | Flow |
| --- | --- |
| `/start`, `/help` | Show the menu. `/start <token>` from Settings → Telegram links the account. |
| `/newinvoice` | Pick or add a client → optional "Repeat last invoice" → currency buttons → lines as `description - price` or `description - 3 x 450` (running subtotal, undo) → due-date buttons → saved payment details → summary where lines, invoice date, due date, tax and payment details can each be changed → create. |
| `/invoices`, `/drafts`, `/unpaid`, `/overdue` | Up to 10 invoices; each offers View, PDF, Attach files, Send, Mark paid (today, yesterday or a typed date). Send emails a private copy with the attachments to the company's business email, then the client. When the company has no business email, the copy goes to `jad@jin-jaw.co.uk`, hardcoded in `src/services/email.ts`. |
| `/uploadinvoice`, `/expense` | A PDF (text extraction) or a receipt photo (OCR) → confirm or change amount, date, category, client and paying company → saved as an expense with the file as evidence. PDFs are filed under the company they were billed to. |
| `/income` | Property / Flats only: money received without an invoice (`income_entries`), counted as "received" in reports. |
| `/workspace`, `/workspaces` | Switch the company the bot acts for. |
| `/pending` | Staff requests waiting for approval, oldest first. Tap one to see it again with its invoice and the Approve and Reject buttons (see Staff submissions bot). |
| `/submitters` | Everyone who asked to use the staff bot, with Allow, Deny and Remove buttons. |

Property / Flats (workspace 2; company id 3 in production, id 2 in a newly
migrated database) has `invoicing_enabled = 0`, so the bot offers only
expenses and income there. The bot lists clients per company through
`client_branches`, while the web app lists them per workspace through
`clients.workspace_id`. Creating a client or invoice in either place keeps
both in step. The bot works per company, not per workspace: `/workspace`
lists every company in every workspace, so Jin&Jaw Arabia (workspace 3 in
production) stays one tap away. A client the bot creates joins the workspace
of the company it acts for.

The Telegram work (migrations `0015_telegram`, `0016_workspace_scoping` and
`0017_direct_income`) was first deployed on 2026-09-21 from a checkout that was
never pushed. On 2026-09-23 it was rebuilt from the deployed bundle and the
production schema, and merged into `main` with the workspaces feature. The
same recovery (commit `a07638a`) added `0015_workspaces` and
`0015_gmail_payment_matching`, which production had applied from their own
branches, and renamed the receipt-photo migration to
`0018_expense_import_images`, which the 2026-09-23 deploy applied.
`0015_gmail_payment_matching` belongs to the Gmail payment reader (see Gmail
payment confirmations). The three `0015` files do not depend on each other:
production applied them in the order gmail, workspaces, telegram, and a new
database applies them in filename order. Deploy only through CI from `main`,
so production never again runs code that git does not have.

## Staff submissions bot

People who are not admins, such as Arabia staff, send expenses and income
through a second Telegram bot. It runs in the same Worker as the admin bot,
with its own BotFather token, webhook and secrets. Every request waits for an
admin to approve it in the admin bot, and nothing reaches `expenses` or
`income_entries` before that.

Requests are always filed under the first active company in the workspace
with the slug `jinjaw-arabia` (Jin&Jaw Arabia S.A.R.L; the slug is
`SUBMISSIONS_WORKSPACE_SLUG` in `src/services/submissions/repository.ts`).
They use that company's currency unless the sender types another one.

### Access

The first message from a Telegram account records an access request in
`telegram_submitters` and sends an Allow and Deny card to every linked admin
chat. Only allowed accounts can send requests. The bot does not ask again
about a denied or removed account; allow it again from `/submitters` in the
admin bot. `/submitters` also shows the link to share with staff when
`SUBMISSIONS_BOT_USERNAME` is set.

### Sending a request

`/expense` or `/income` in the staff bot starts a request. The sender then
sends a photo or PDF of the invoice, or types it, for example
`Taxi to airport 25` or `120 EUR`. Photos are read by the same Workers AI
model as receipt photos in the admin bot, and PDFs by the same text
extraction as supplier invoices. An income invoice names Jin&Jaw Arabia as
its issuer, so for income the bot ignores the supplier it reads and always
asks who paid. A file or an amount sent without a command makes the bot ask
whether it is an expense or income.

The summary lets the sender change the amount, the name, the date, the
category (expenses only) and a note for the admin, then send it for
approval. `/mine` shows their last 10 requests with their status and any
rejection reason.

Each request is one row in `submissions`. While the sender fills it in, its
status is `draft`, and the daily cron deletes drafts left untouched for a
day. A sent request is `pending` until an admin decides.

### Approving

Each sent request arrives in every linked admin chat (the rows of
`telegram_connections` with `personal_notifications = 1`) as a card: the
photo or PDF with the details as its caption, and Approve and Reject buttons.
`/pending` lists up to 10 waiting requests and shows any of them again.

Approve writes the expense or income entry and copies the file into
`expense_attachments` or `income_attachments`, all in one D1 batch. A second
tap, or another admin's tap on their own card, changes nothing. The expense
description or the income reference records the request number, the sender
and their note. Income is linked to a client of the company whose name
matches the payer, ignoring case, and otherwise has no client.

Reject asks for a reason, which the sender receives; "Reject without a reason"
skips it. The sender gets a message with either decision. The daily cron
removes the file of a rejected request 30 days after the decision.

Approved expenses can be edited on the web like any other expense. Income
entries have no web page yet, so income evidence is only in
`income_attachments` and the SQL backup.

### Setting up the staff bot

1. Create the bot in BotFather and note its token and username.
2. Store the three secrets with `npx wrangler secret put SUBMISSIONS_BOT_TOKEN`,
   `npx wrangler secret put SUBMISSIONS_WEBHOOK_SECRET` and
   `npx wrangler secret put SUBMISSIONS_BOT_USERNAME`. The webhook secret
   follows the same rules as the admin bot's.
3. Register the webhook as described in Registering the webhook, with the
   staff bot's token and secret and the URL
   `https://invoices.jin-jaw.co.uk/api/integrations/telegram/submissions/webhook`.

Until the token and secret exist, that endpoint answers 503. The admin bot
must also be set up, because the approval cards go through it.

To stop the staff bot, delete its webhook with its own token, or delete
`SUBMISSIONS_WEBHOOK_SECRET`. To stop one person, use Remove in
`/submitters`.

The code is in `src/services/submissions/` (`handler.ts` holds the staff
bot's conversation, `review.ts` the admin cards and decisions,
`repository.ts` the D1 access and `format.ts` the shared text), with
migration `0020_submissions` and `test/submissions.integration.test.ts`.

## Gmail payment confirmations

The Worker reads one Gmail mailbox with the read-only `gmail.readonly` scope
and closes sent invoices that a trusted payment email matches. The hourly cron
trigger runs the check. **Check Gmail now**, on the dashboard or in
Settings → Gmail payments, runs it on demand.

- **Matching:** only invoices with status sent are candidates. A message that
  names exactly one sent invoice number is matched to that invoice when an
  amount in the invoice currency is within 2% of the total, or when all its
  amounts are in other currencies (a converted receipt). A message without an
  invoice number is matched only when a same-currency amount within 2% fits
  exactly one sent invoice. Every other message is recorded as ignored or
  review and changes nothing.
- **Result of a match:** a manual payment of the full invoice total, dated on
  the email, with the note "Automatically matched from Gmail message …". The
  linked Telegram chat gets the usual "Payment received" message.
- **Search:** Settings → Gmail payments holds the Gmail search, which must
  contain a `from:` sender address. Keep the trusted senders there, not in
  git. Each check reads up to 25 matching messages and skips every message id
  already in `gmail_payment_events`.
- **Credentials:** the Google OAuth client is `GMAIL_CLIENT_ID` and
  `GMAIL_CLIENT_SECRET` (Worker secrets), with
  `https://invoices.jin-jaw.co.uk/admin/settings/gmail/callback` as its
  redirect URI. The refresh token is saved in Settings, encrypted with
  `SETTINGS_MASTER_KEY`.
- **Failures:** a failed check logs `gmail_payment_scan_failed`. When the last
  completed check is more than three hours old, the dashboard shows a warning.
  The usual fix is Settings → Gmail payments → Reconnect Gmail.
- **Undoing a match:** use Undo on the payment in the invoice's Payments card.
  The message stays in `gmail_payment_events`, so later checks do not match it
  again.
- **Stopping it:** untick "Automatically mark trusted payment matches paid", or
  use Disconnect Gmail, which also deletes the stored token. To end Google's
  grant as well, remove the app's access in the Google Account security
  settings.
- **Code:** `src/services/gmail-payments.ts` (with its unit tests beside it),
  the Gmail routes in `src/routes/admin.tsx` (after the Telegram routes), and
  `test/gmail-payments.integration.test.ts`.

The reader was built on branch `JADPTFIXES/invoice-page-work` and ran in
production from 2026-09-05 until `main` was deployed without it on
2026-09-21. It was brought onto `main` on 2026-09-23.

## Backups and recovery

Run `npm run db:backup:prod` regularly and copy the resulting gitignored SQL
file from `backups/` into Jin&Jaw's encrypted business backup location, then
delete the local copy. Always take a fresh export before deploying
migrations, making a large import, or restoring.

Never commit an export: it contains client and financial data. It also holds
the credentials saved in Settings, encrypted with `SETTINGS_MASTER_KEY`, which
the export does not contain.

### Time Travel

D1 Time Travel restores the database to any minute in the last 30 days, the
retention on the Workers Paid plan. A restore overwrites the live database in
place and keeps its id, so no config change or deploy follows.

```sh
npx wrangler d1 time-travel info DB --timestamp=<RFC 3339 time>
npx wrangler d1 time-travel restore DB --timestamp=<RFC 3339 time>
```

`info` only looks up the bookmark for a time such as `2026-09-23T12:00:00Z`.
`restore` asks for confirmation, then prints the bookmark from just before
the restore. To undo the restore, run
`npx wrangler d1 time-travel restore DB --bookmark=<that bookmark>`.

### Restoring an SQL export

Use an export when the loss is older than 30 days or the database is gone.
Import only into an empty database: the export contains the full schema and
the `d1_migrations` table.

1. Create an empty database:
   `npx wrangler d1 create jinjaw-invoices-eu-restore --jurisdiction eu`
   (use `jinjaw-invoices-eu` when rebuilding in a new account).
2. Import the export:
   `npx wrangler d1 execute jinjaw-invoices-eu-restore --remote --file=backups/<export>.sql`.
3. Check the data:
   `npx wrangler d1 execute jinjaw-invoices-eu-restore --remote --command "SELECT count(*) FROM invoices"`.
4. Put the new `database_name` and `database_id` in `wrangler.jsonc`, keep the
   binding `DB`, then commit and push to `main`. CI applies only the
   migrations newer than the export, then deploys.
5. Keep the old database until the restored one has been checked.

The same Worker keeps its `SETTINGS_MASTER_KEY`, so saved credentials still
decrypt. A new Worker gets a new key, so re-enter them in Settings.

## Routine maintenance

Every push to `main` runs type-checking, tests, and a Worker dry run in GitHub
Actions. Production deploys only after all three checks pass. A push that
arrives during a deploy waits for it to finish instead of cancelling it. The
deploy job applies pending D1 migrations, publishes the Worker, and verifies
that the settings encryption key exists. GitHub stores the Cloudflare
credentials as the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
repository secrets; never add either value to the repository.

- `npm ci` — install the audited lockfile.
- `npm test` — run the unit and D1 integration suite.
- `npm run typecheck` — type-check Worker and tests.
- `npm run deploy:dry-run` — validate the production bundle without deploying.
- `npm run deploy` — migrate D1 and deploy the Worker.
- `npm run db:backup:prod` — export a timestamped production snapshot.
- `npx wrangler tail jinjaw-invoices` — inspect live structured Worker logs.

Before a large change, compare `npx wrangler d1 migrations list DB --remote`
with `migrations/`: the list must be empty or show only your new files.

With wrangler 4.127.1 (checked on 2026-09-25), `wrangler dev --local` and the
full test suite, D1 integration tests included, run on Windows. Older
versions failed to start workerd there, so CI was the only place those tests
ran.

Do not rotate or delete `SETTINGS_MASTER_KEY` without first removing or
re-entering any API credentials stored through the app. Wrangler secrets take
precedence and are the preferred place for payment and email credentials.
