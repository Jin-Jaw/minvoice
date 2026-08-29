import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import {
  formatCents,
  isClientRateCurrency,
  isSupportedCurrency,
  parseAmountToCents,
  type ClientRateCurrency,
} from '../lib/money';
import { addDaysISO, isValidTimezone, todayInTz } from '../lib/dates';
import { configWarnings, secretConfigured } from '../lib/config';
import { accentUsable, safeAccent } from '../lib/color';
import { effectiveProviderEnv, encryptStoredSecrets, keySource } from '../lib/providers';
import { sealIfKeyed, unbox, validMasterKey } from '../lib/secretbox';
import { isLocalRequest } from '../lib/admin-auth';
import { parseSchedule } from '../lib/reminders';
import {
  buildTimeline,
  completeSetup,
  createBranch,
  createClient,
  deleteLogo,
  getLogo,
  createInvoice,
  deleteInvoice,
  deleteViewEvent,
  getClient,
  getInvoiceById,
  getInvoiceEvents,
  getInvoiceItems,
  getInvoiceSourcePdf,
  getPayments,
  getSettings,
  logInvoiceEvent,
  invoiceNumberExists,
  listAllPayments,
  listAllInvoices,
  listBranches,
  listClients,
  listInvoices,
  hasInvoiceSourcePdf,
  markInvoiceSent,
  markInvoiceUnsent,
  monthlyReport,
  reportSummary,
  suggestedInvoiceNumber,
  recordManualPayment,
  undoPayment,
  updatePaymentNote,
  setInvoiceStatus,
  setLogo,
  setInvoiceSourcePdf,
  updateClient,
  updateInvoice,
  setNextInvoiceNumber,
  setResendApiKey,
  updateEmailSettings,
  updateSettings,
  type ItemDraft,
} from '../db/queries';
import { DashboardPage, INVOICE_FILTERS, type InvoiceFilter } from '../views/admin/dashboard';
import { generateInvoicePdf } from '../services/pdf';
import { sendInvoiceEmail, sendInvoiceEmailToClientAndOwner, sendTestEmail } from '../services/email';
import { InvoiceFormPage } from '../views/admin/invoice-form';
import { InvoiceDetailPage } from '../views/admin/invoice-detail';
import { ClientEditPage, ClientNewPage, ClientsPage } from '../views/admin/clients';
import { PaymentsPage } from '../views/admin/payments';
import { ReportsPage } from '../views/admin/reports';
import { SettingsPage } from '../views/admin/settings';
import { SetupPage } from '../views/admin/setup';
import { BranchesPage } from '../views/admin/branches';

export const admin = new Hono<AppEnv>();

// ---------- First-launch setup wizard ----------

// Gate every admin page behind the wizard until required settings exist.
admin.use('*', async (c, next) => {
  if (c.req.path === '/admin/setup') return next();
  const settings = await getSettings(c.env.DB, c.get('branchId'));
  if (!settings.setup_complete) return c.redirect('/admin/setup');
  await next();
});

admin.get('/setup', async (c) => {
  const settings = await getSettings(c.env.DB, c.get('branchId'));
  if (settings.setup_complete) return c.redirect('/admin');
  // Cloudflare geolocates the request — prefill the visitor's timezone.
  const detected = (c.req.raw.cf as { timezone?: string } | undefined)?.timezone;
  return c.html(
    <SetupPage
      nonce={c.get('secureHeadersNonce')}
      values={{
        business_name: settings.business_name || 'Jin&Jaw LTD',
        business_email: settings.business_email || 'contact@jin-jaw.co.uk',
        business_address: settings.business_address,
        currency: settings.currency || 'GBP',
        timezone:
          settings.timezone !== 'UTC'
            ? settings.timezone
            : detected && isValidTimezone(detected)
              ? detected
              : 'Europe/London',
        invoice_prefix: settings.invoice_prefix || 'INV-',
        payment_terms_days: settings.payment_terms_days ? String(settings.payment_terms_days) : '',
        default_rate: settings.default_rate_cents
          ? (settings.default_rate_cents / 100).toFixed(2)
          : '',
      }}
    />
  );
});

admin.post('/setup', async (c) => {
  const branchId = c.get('branchId');
  const settings = await getSettings(c.env.DB, branchId);
  if (settings.setup_complete) return c.redirect('/admin');

  const body = (await c.req.parseBody()) as Record<string, string>;
  const values = {
    business_name: body.business_name?.trim() ?? '',
    business_email: body.business_email?.trim() ?? '',
    business_address: body.business_address?.trim() ?? '',
    currency: (body.currency?.trim() ?? '').toUpperCase(),
    timezone: body.timezone ?? 'UTC',
    invoice_prefix: body.invoice_prefix?.trim() || 'INV-',
    payment_terms_days: body.payment_terms_days ?? '',
    default_rate: body.default_rate ?? '',
  };

  const problems: string[] = [];
  if (!values.business_name) problems.push('business name');
  if (!values.business_email || !values.business_email.includes('@')) problems.push('business email');
  if (!isSupportedCurrency(values.currency))
    problems.push('currency (3-letter code; zero-decimal currencies like JPY are not supported)');
  if (!isValidTimezone(values.timezone)) problems.push('time zone');
  if (problems.length) {
    return c.html(
      <SetupPage error={`Please provide a valid ${problems.join(', ')}.`} values={values} nonce={c.get('secureHeadersNonce')} />,
      400
    );
  }

  await updateSettings(c.env.DB, branchId, {
    business_name: values.business_name,
    business_address: values.business_address,
    business_email: values.business_email,
    logo_url: 'https://jin-jaw.co.uk/assets/jinjaw-square.png',
    currency: values.currency,
    tax_rate_bps: 0,
    invoice_prefix: values.invoice_prefix,
    default_rate_cents: (values.default_rate && parseAmountToCents(values.default_rate)) || 0,
    default_payment_details: '',
    timezone: values.timezone,
    locale: 'en',
    accent_color: '#ef4958',
    // No send_email binding (zero-config deploys) -> Resend is the workable provider
    email_provider: c.env.EMAIL ? 'cloudflare' : 'resend',
    email_from: '',
    payment_terms_days: Math.max(0, parseInt(values.payment_terms_days, 10) || 0),
  });
  await completeSetup(c.env.DB);
  return c.redirect('/admin');
});

/** A plausible BCP-47 tag like 'en', 'de-AT', 'fr-CA' (strings fall back to English for unknown languages). */
function validLocaleTag(v: string | undefined): v is string {
  return !!v && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(v.trim());
}

/** The submitted locale: the select's value, or the free-text field when "Custom tag…" was chosen. */
function submittedLocale(body: Record<string, string>): string | undefined {
  return body.locale === '__custom__' ? body.locale_custom : body.locale;
}

/** Normalize a parseBody({ all: true }) field into a string[]. */
function arr(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Parse line items, reporting every problem by line number instead of
 * silently dropping bad rows. Fully blank rows are ignored; a row with ANY
 * content must be complete and valid.
 */
function parseItemDrafts(body: Record<string, string | string[]>): { items: ItemDraft[]; problems: string[] } {
  const descriptions = arr(body['item_description[]']);
  const quantities = arr(body['item_quantity[]']);
  const unitPrices = arr(body['item_unit_price[]']);
  const rowCount = Math.max(descriptions.length, quantities.length, unitPrices.length);

  const items: ItemDraft[] = [];
  const problems: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const description = (descriptions[i] ?? '').trim();
    const priceRaw = (unitPrices[i] ?? '').trim();
    const qtyRaw = (quantities[i] ?? '').trim();
    if (!description && !priceRaw) continue; // untouched row

    const line = `Line ${i + 1}`;
    let ok = true;
    if (!description) {
      problems.push(`${line}: description is missing.`);
      ok = false;
    }
    const unitPriceCents = parseAmountToCents(priceRaw);
    if (!priceRaw) {
      problems.push(`${line}: unit price is missing.`);
      ok = false;
    } else if (unitPriceCents === null) {
      problems.push(`${line}: "${priceRaw}" is not a valid amount.`);
      ok = false;
    }
    const quantity = qtyRaw === '' ? 1 : parseFloat(qtyRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      problems.push(`${line}: quantity must be a positive number.`);
      ok = false;
    }
    if (ok) items.push({ description, quantity, unit_price_cents: unitPriceCents! });
  }
  if (items.length === 0 && problems.length === 0) {
    problems.push('Add at least one line item.');
  }
  return { items, problems };
}

/** Header-field checks shared by create and edit. */
async function invoiceHeaderProblems(
  db: D1Database,
  body: Record<string, string | string[]>,
  opts: { checkClient: boolean }
): Promise<string[]> {
  const problems: string[] = [];
  if (opts.checkClient) {
    const clientId = Number(str(body.client_id));
    if (!Number.isInteger(clientId) || !(await getClient(db, clientId))) {
      problems.push('Select a client.');
    }
  }
  const issue = str(body.issue_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue)) {
    problems.push('Issue date is required.');
  }
  const due = str(body.due_date);
  if (due && issue && due < issue) {
    problems.push(`Due date (${due}) is before the issue date (${issue}).`);
  }
  const currency = str(body.currency).trim().toUpperCase();
  if (currency && !isSupportedCurrency(currency)) {
    problems.push(`Currency "${currency}" isn't supported (unknown code, or a zero-decimal currency like JPY).`);
  }
  return problems;
}

function str(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/** Only return to the invoice list and preserve its supported filters. */
function invoiceListReturnTo(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, 'https://invoice-list.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://invoice-list.invalid' || url.pathname !== '/admin') return null;

  const params = new URLSearchParams();
  const status = url.searchParams.get('status');
  if (status && (INVOICE_FILTERS as readonly string[]).includes(status)) params.set('status', status);
  if (url.searchParams.get('scope') === 'current') params.set('scope', 'current');
  const client = Number(url.searchParams.get('client'));
  if (Number.isInteger(client) && client > 0) params.set('client', String(client));
  const query = params.toString();
  return query ? `/admin?${query}` : '/admin';
}

function addListNotice(path: string, key: 'paid' | 'emailed' | 'email_error', value: string): string {
  const url = new URL(path, 'https://invoice-list.invalid');
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

// ---------- Dashboard ----------

admin.get('/', async (c) => {
  const branchId = c.get('branchId');
  const [invoices, settings] = await Promise.all([
    listAllInvoices(c.env.DB),
    getSettings(c.env.DB, branchId),
  ]);
  const status = c.req.query('status');
  const filter: InvoiceFilter = (INVOICE_FILTERS as readonly string[]).includes(status ?? '')
    ? (status as InvoiceFilter)
    : 'all';
  const clientParam = Number(c.req.query('client'));
  const clientId = Number.isInteger(clientParam) && clientParam > 0 ? clientParam : undefined;
  return c.html(
    <DashboardPage
      invoices={invoices}
      filter={filter}
      clientId={clientId}
      deleted={c.req.query('deleted')}
      paid={c.req.query('paid')}
      emailed={c.req.query('emailed')}
      emailError={c.req.query('email_error')}
      emailEnabled={settings.email_provider !== 'none'}
      today={todayInTz(settings.timezone)}
      warnings={(await configWarnings(c.env, settings))
        .filter((w) => w.category !== 'auth')
        .map((w) => w.text)}
      currentPath="/admin"
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

// ---------- Invoices: new ----------

admin.get('/invoices/new', async (c) => {
  const branches = await listBranches(c.env.DB);
  const requestedBranchId = Number(c.req.query('branch'));
  const branchId = branches.some((branch) => branch.id === requestedBranchId)
    ? requestedBranchId
    : c.get('branchId');
  const [clients, settings, logo] = await Promise.all([
    listClients(c.env.DB),
    getSettings(c.env.DB, branchId),
    getLogo(c.env.DB, branchId),
  ]);
  return c.html(
    <InvoiceFormPage
      currentPath="/admin"
      clients={clients}
      branches={branches}
      settings={settings}
      hasLogo={!!logo}
      suggestedNumber={await suggestedInvoiceNumber(c.env.DB, settings)}
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

admin.post('/invoices/new', async (c) => {
  const body = (await c.req.parseBody({ all: true })) as Record<string, string | string[]>;
  const branches = await listBranches(c.env.DB);
  const branchId = Number(str(body.branch_id));
  if (!branches.some((branch) => branch.id === branchId)) return c.text('Choose a valid issuing company.', 400);
  const [clients, settings, logo] = await Promise.all([
    listClients(c.env.DB),
    getSettings(c.env.DB, branchId),
    getLogo(c.env.DB, branchId),
  ]);
  const { items, problems: itemProblems } = parseItemDrafts(body);
  const suggested = await suggestedInvoiceNumber(c.env.DB, settings);

  const rerender = (errors: string[]) =>
    c.html(
      <InvoiceFormPage
        currentPath="/admin"
        clients={clients}
        branches={branches}
        settings={settings}
        hasLogo={!!logo}
        suggestedNumber={suggested}
        nonce={c.get('secureHeadersNonce')}
        errors={errors}
        formValues={{
          number: str(body.number),
          client_id: str(body.client_id),
          issue_date: str(body.issue_date),
          due_date: str(body.due_date),
          currency: str(body.currency),
          subject: str(body.subject),
          notes: str(body.notes),
          item_description: arr(body['item_description[]']),
          item_quantity: arr(body['item_quantity[]']),
          item_unit_price: arr(body['item_unit_price[]']),
        }}
      />,
      400
    );

  const problems = [...(await invoiceHeaderProblems(c.env.DB, body, { checkClient: true })), ...itemProblems];

  // Blank or untouched number -> auto counter; anything else is a custom number.
  const typedNumber = str(body.number).trim();
  const customNumber = typedNumber && typedNumber !== suggested ? typedNumber : undefined;
  if (customNumber && (await invoiceNumberExists(c.env.DB, branchId, customNumber))) {
    problems.push(`Invoice number "${customNumber}" is already in use.`);
  }
  if (problems.length) return rerender(problems);
  const clientId = Number(str(body.client_id));

  try {
    const invoiceId = await createInvoice(
      c.env.DB,
      branchId,
      {
        client_id: clientId,
        issue_date: str(body.issue_date),
        due_date: str(body.due_date) || null,
        subject: str(body.subject).trim() || null,
        notes: str(body.notes) || null,
        currency: str(body.currency).trim().toUpperCase() || undefined,
        items,
      },
      customNumber
    );
    return c.redirect(`/admin/invoices/${invoiceId}`);
  } catch (e) {
    // Lost a race on the UNIQUE(number) constraint — surface it instead of a 500.
    if (String(e).includes('UNIQUE')) {
      return rerender(['That invoice number was just taken — please try again.']);
    }
    throw e;
  }
});

// ---------- Invoices: detail ----------

admin.get('/invoices/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const invoice = await getInvoiceById(c.env.DB, id);
  if (!invoice) return c.notFound();
  const branchId = invoice.branch_id;

  const [items, payments, events, settings, hasOriginalPdf] = await Promise.all([
    getInvoiceItems(c.env.DB, id),
    getPayments(c.env.DB, id),
    getInvoiceEvents(c.env.DB, id),
    getSettings(c.env.DB, branchId),
    hasInvoiceSourcePdf(c.env.DB, id),
  ]);
  const timeline = buildTimeline(invoice, payments, events, formatCents);
  const emailedTo = c.req.query('emailed');
  const emailError = c.req.query('email_error');

  return c.html(
    <InvoiceDetailPage
      currentPath="/admin"
      invoice={invoice}
      items={items}
      payments={payments}
      timeline={timeline}
      timezone={settings.timezone}
      emailEnabled={settings.email_provider !== 'none'}
      hasOriginalPdf={hasOriginalPdf}
      notice={
        emailedTo
          ? `Invoice emailed to ${emailedTo}.`
          : c.req.query('pdf_saved')
            ? 'Original invoice PDF archived.'
            : undefined
      }
      error={emailError}
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

// ---------- Invoices: edit ----------

admin.get('/invoices/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const invoice = await getInvoiceById(c.env.DB, id);
  if (!invoice) return c.notFound();
  const branchId = invoice.branch_id;

  if (invoice.status !== 'draft' && invoice.status !== 'sent') {
    return c.redirect(`/admin/invoices/${id}`);
  }

  const [clients, items, settings, logo] = await Promise.all([
    listClients(c.env.DB),
    getInvoiceItems(c.env.DB, id),
    getSettings(c.env.DB, branchId),
    getLogo(c.env.DB, branchId),
  ]);

  return c.html(
    <InvoiceFormPage
      currentPath="/admin"
      clients={clients}
      settings={settings}
      hasLogo={!!logo}
      invoice={invoice}
      items={items}
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

admin.post('/invoices/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const invoice = await getInvoiceById(c.env.DB, id);
  if (!invoice) return c.notFound();
  const branchId = invoice.branch_id;

  if (invoice.status !== 'draft' && invoice.status !== 'sent') {
    return c.redirect(`/admin/invoices/${id}`);
  }

  const body = (await c.req.parseBody({ all: true })) as Record<string, string | string[]>;
  const { items, problems: itemProblems } = parseItemDrafts(body);
  const problems = [...(await invoiceHeaderProblems(c.env.DB, body, { checkClient: true })), ...itemProblems];

  if (problems.length) {
    const [clients, settings, logo] = await Promise.all([
      listClients(c.env.DB),
      getSettings(c.env.DB, branchId),
      getLogo(c.env.DB, branchId),
    ]);
    return c.html(
      <InvoiceFormPage
        currentPath="/admin"
        clients={clients}
        settings={settings}
        hasLogo={!!logo}
        invoice={invoice}
        nonce={c.get('secureHeadersNonce')}
        errors={problems}
        formValues={{
          client_id: str(body.client_id),
          issue_date: str(body.issue_date),
          due_date: str(body.due_date),
          currency: str(body.currency),
          subject: str(body.subject),
          notes: str(body.notes),
          item_description: arr(body['item_description[]']),
          item_quantity: arr(body['item_quantity[]']),
          item_unit_price: arr(body['item_unit_price[]']),
        }}
      />,
      400
    );
  }

  await updateInvoice(c.env.DB, branchId, id, {
    client_id: Number(str(body.client_id)),
    issue_date: str(body.issue_date),
    due_date: str(body.due_date) || null,
    subject: str(body.subject).trim() || null,
    notes: str(body.notes) || null,
    currency: str(body.currency).trim().toUpperCase() || undefined,
    items,
  });
  await logInvoiceEvent(c.env.DB, id, 'edited');

  return c.redirect(`/admin/invoices/${id}`);
});

// ---------- Invoices: status transitions ----------

admin.post('/invoices/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const invoice = await getInvoiceById(c.env.DB, id);
  if (!invoice) return c.notFound();
  const branchId = invoice.branch_id;

  const body = (await c.req.parseBody()) as Record<string, string>;
  const action = body.action;
  const returnTo = invoiceListReturnTo(body.return_to);
  const today = todayInTz((await getSettings(c.env.DB, branchId)).timezone);

  switch (action) {
    case 'send': {
      // Drafts become sent; sent invoices can have their date adjusted.
      // Never resurrects a paid/void invoice (guarded again in SQL).
      if (invoice.status === 'draft' || invoice.status === 'sent') {
        const raw = body.sent_date?.trim();
        // "Today" means now — keep the full timestamp; only real backdates stay date-only.
        const sentDate = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && raw !== today ? raw : undefined;

        // The email path: send first, mark sent only on success.
        if (body.email === '1') {
          if (!invoice.client_email) {
            const reason = 'Client has no email address.';
            return c.redirect(
              returnTo ? addListNotice(returnTo, 'email_error', reason) : `/admin/invoices/${id}?email_error=${encodeURIComponent(reason)}`
            );
          }
          let ownerCopyAddress = 'jad@jin-jaw.co.uk';
          try {
            const [items, settings, sourcePdf] = await Promise.all([
              getInvoiceItems(c.env.DB, id),
              getSettings(c.env.DB, branchId),
              getInvoiceSourcePdf(c.env.DB, id),
            ]);
            const pdf = sourcePdf?.bytes ?? await generateInvoicePdf(
              invoice,
              items,
              settings,
              c.env.ASSETS,
              await getLogo(c.env.DB, branchId)
            );
            ownerCopyAddress = await sendInvoiceEmailToClientAndOwner(c.env, invoice, settings, pdf);
          } catch (e) {
            console.error('invoice email failed', e);
            const reason = e instanceof Error ? e.message.slice(0, 160) : 'unknown error';
            const message = `The invoice was not marked sent. (${reason})`;
            return c.redirect(
              returnTo
                ? addListNotice(returnTo, 'email_error', message)
                : `/admin/invoices/${id}?email_error=${encodeURIComponent(`Email failed to send — ${message}`)}`
            );
          }
          if (invoice.status === 'draft') {
            await markInvoiceSent(c.env.DB, id);
            await logInvoiceEvent(c.env.DB, id, 'sent');
          }
          await logInvoiceEvent(
            c.env.DB,
            id,
            'emailed',
            `Invoice emailed to ${invoice.client_email}; separate copy sent to ${ownerCopyAddress}`
          );
          return c.redirect(
            returnTo
              ? addListNotice(returnTo, 'emailed', invoice.client_email)
              : `/admin/invoices/${id}?emailed=${encodeURIComponent(invoice.client_email)}`
          );
        }

        await markInvoiceSent(c.env.DB, id, sentDate);
        if (invoice.status === 'draft') {
          await logInvoiceEvent(c.env.DB, id, 'sent', sentDate ? `Dated ${sentDate}` : undefined);
        } else if (sentDate && sentDate !== invoice.sent_at?.slice(0, 10)) {
          await logInvoiceEvent(c.env.DB, id, 'sent_date_changed', `Sent date set to ${sentDate}`);
        }
      }
      break;
    }
    case 'unsend':
      if (invoice.status === 'sent') {
        await markInvoiceUnsent(c.env.DB, id);
        await logInvoiceEvent(c.env.DB, id, 'unsent');
      }
      break;
    case 'void':
      if (invoice.status === 'draft' || invoice.status === 'sent') {
        await setInvoiceStatus(c.env.DB, id, 'void');
        await logInvoiceEvent(c.env.DB, id, 'voided');
      }
      break;
    case 'mark_paid':
      if (invoice.status === 'draft' || invoice.status === 'sent') {
        const paymentDate = body.payment_date?.trim();
        await recordManualPayment(c.env.DB, invoice, {
          note: body.note?.trim() || undefined,
          // "Today" means now — keep the full timestamp; only real backdates stay date-only.
          paidDate:
            paymentDate && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate) && paymentDate !== today
              ? paymentDate
              : undefined,
        });
      }
      break;
    case 'delete':
      await deleteInvoice(c.env.DB, id);
      return c.redirect(`/admin?deleted=${encodeURIComponent(invoice.number)}`);
    default:
      break;
  }

  if (returnTo) {
    return c.redirect(action === 'mark_paid' ? addListNotice(returnTo, 'paid', invoice.number) : returnTo);
  }
  return c.redirect(`/admin/invoices/${id}`);
});

admin.post('/invoices/:id/duplicate', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const source = await getInvoiceById(c.env.DB, id);
  if (!source) return c.notFound();
  const branchId = source.branch_id;

  const [items, settings, client] = await Promise.all([
    getInvoiceItems(c.env.DB, id),
    getSettings(c.env.DB, branchId),
    getClient(c.env.DB, source.client_id),
  ]);
  const today = todayInTz(settings.timezone);
  const terms = client?.payment_terms_days ?? settings.payment_terms_days;

  const newId = await createInvoice(c.env.DB, branchId, {
    client_id: source.client_id,
    issue_date: today,
    due_date: terms > 0 ? addDaysISO(today, terms) : null,
    subject: source.subject,
    notes: source.notes,
    currency: source.currency,
    items: items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      unit_price_cents: it.unit_price_cents,
    })),
  });
  await logInvoiceEvent(c.env.DB, newId, 'duplicated', `Duplicated from ${source.number}`);
  return c.redirect(`/admin/invoices/${newId}`);
});

// "Email me a copy": the exact client email (with PDF) rerouted to the
// business address. The client is never contacted and no status changes.
admin.post('/invoices/:id/email-copy', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const invoice = await getInvoiceById(c.env.DB, id);
  if (!invoice) return c.notFound();
  const branchId = invoice.branch_id;

  const settings = await getSettings(c.env.DB, branchId);
  const to = settings.business_email;
  if (!to) {
    return c.redirect(
      `/admin/invoices/${id}?email_error=${encodeURIComponent('Set a business email in Settings first — the copy is sent to it.')}`
    );
  }
  try {
    const [items, sourcePdf] = await Promise.all([
      getInvoiceItems(c.env.DB, id),
      getInvoiceSourcePdf(c.env.DB, id),
    ]);
    const pdf =
      sourcePdf?.bytes ??
      (await generateInvoicePdf(invoice, items, settings, c.env.ASSETS, await getLogo(c.env.DB, branchId)));
    await sendInvoiceEmail(c.env, invoice, settings, pdf, to);
  } catch (e) {
    console.error('invoice copy email failed', e);
    const reason = e instanceof Error ? e.message.slice(0, 160) : 'unknown error';
    return c.redirect(
      `/admin/invoices/${id}?email_error=${encodeURIComponent(`Email failed to send — ${reason}`)}`
    );
  }
  await logInvoiceEvent(c.env.DB, id, 'emailed', `Copy emailed to ${to}`);
  return c.redirect(`/admin/invoices/${id}?emailed=${encodeURIComponent(to)}`);
});

admin.post('/invoices/:id/payments/:pid/undo', async (c) => {
  const id = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  if (!Number.isInteger(id) || !Number.isInteger(pid)) return c.notFound();

  const invoice = await getInvoiceById(c.env.DB, id);
  if (!invoice) return c.notFound();

  await undoPayment(c.env.DB, id, pid, formatCents);
  return c.redirect(`/admin/invoices/${id}`);
});

admin.post('/invoices/:id/payments/:pid/note', async (c) => {
  const id = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  if (!Number.isInteger(id) || !Number.isInteger(pid)) return c.notFound();
  if (!(await getInvoiceById(c.env.DB, id))) return c.notFound();

  const body = (await c.req.parseBody()) as Record<string, string>;
  const note = body.note?.trim() || null;
  const updated = await updatePaymentNote(c.env.DB, id, pid, note);
  if (updated) {
    await logInvoiceEvent(c.env.DB, id, 'payment_note_edited', note ?? 'Note cleared');
  }
  return c.redirect(`/admin/invoices/${id}`);
});

// ---------- Clients ----------

admin.get('/clients', async (c) => {
  const clients = await listClients(c.env.DB, true);
  return c.html(
    <ClientsPage currentPath="/admin/clients" clients={clients} nonce={c.get('secureHeadersNonce')} />
  );
});

admin.post('/clients', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string>;
  const defaultCurrency = body.default_currency?.trim().toUpperCase() ?? '';
  if (!isClientRateCurrency(defaultCurrency)) return c.text('Rate currency must be USD, GBP, or EUR.', 400);
  await createClient(c.env.DB, {
    name: body.name,
    email: body.email || null,
    address: body.address || null,
    default_rate_cents: body.default_rate ? parseAmountToCents(body.default_rate) : null,
    default_currency: defaultCurrency,
    payment_terms_days: body.payment_terms_days?.trim() ? Math.max(0, parseInt(body.payment_terms_days, 10) || 0) : null,
    locale: validLocaleTag(submittedLocale(body)) ? submittedLocale(body)!.trim() : null,
  });
  return c.redirect('/admin/clients');
});

// Registered before /clients/:id so the static path wins.
admin.get('/clients/new', async (c) => {
  const settings = await getSettings(c.env.DB, c.get('branchId'));
  const defaultCurrency: ClientRateCurrency = isClientRateCurrency(settings.currency) ? settings.currency : 'GBP';
  return c.html(
    <ClientNewPage
      currentPath="/admin/clients"
      defaultCurrency={defaultCurrency}
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

admin.post('/invoices/:id/source-pdf', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();
  const invoice = await getInvoiceById(c.env.DB, id);
  if (!invoice) return c.notFound();

  const body = await c.req.parseBody();
  const file = body.source_pdf;
  if (!(file instanceof File) || file.size === 0) return c.text('Choose a PDF file.', 400);
  if (file.size > 750 * 1024) return c.text('Original PDF must be under 750 KB.', 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') return c.text('That file is not a valid PDF.', 400);
  const filename = `${invoice.number}.pdf`;
  await setInvoiceSourcePdf(c.env.DB, id, bytes, filename);
  await logInvoiceEvent(c.env.DB, id, 'source_pdf_archived', `Original PDF archived as ${filename}`);
  return c.redirect(`/admin/invoices/${id}?pdf_saved=1`);
});

admin.get('/clients/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const client = await getClient(c.env.DB, id);
  if (!client) return c.notFound();

  return c.html(
    <ClientEditPage currentPath="/admin/clients" client={client} nonce={c.get('secureHeadersNonce')} />
  );
});

admin.post('/clients/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const client = await getClient(c.env.DB, id);
  if (!client) return c.notFound();

  const body = (await c.req.parseBody()) as Record<string, string>;
  const defaultCurrency = body.default_currency?.trim().toUpperCase() ?? '';
  if (!isClientRateCurrency(defaultCurrency)) return c.text('Rate currency must be USD, GBP, or EUR.', 400);
  await updateClient(c.env.DB, id, {
    name: body.name,
    email: body.email || null,
    address: body.address || null,
    archived: body.archived ? 1 : 0,
    default_rate_cents: body.default_rate ? parseAmountToCents(body.default_rate) : null,
    default_currency: defaultCurrency,
    payment_terms_days: body.payment_terms_days?.trim() ? Math.max(0, parseInt(body.payment_terms_days, 10) || 0) : null,
    locale: validLocaleTag(submittedLocale(body)) ? submittedLocale(body)!.trim() : null,
  });

  return c.redirect('/admin/clients');
});

// ---------- Invoice branches (clients and provider configuration stay shared) ----------

admin.get('/branches', async (c) =>
  c.html(
    <BranchesPage
      branches={await listBranches(c.env.DB)}
      nonce={c.get('secureHeadersNonce')}
    />
  )
);

admin.post('/branches', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string>;
  const name = (body.name ?? '').trim();
  const businessAddress = (body.business_address ?? '').trim();
  const businessEmail = (body.business_email ?? '').trim();
  const currency = (body.currency ?? '').trim().toUpperCase();
  const invoicePrefix = (body.invoice_prefix ?? '').trim();
  const invalid =
    !name ||
    name.length > 120 ||
    !businessAddress ||
    (businessEmail !== '' && !businessEmail.includes('@')) ||
    !isSupportedCurrency(currency) ||
    !invoicePrefix ||
    invoicePrefix.length > 40;
  if (invalid) {
    return c.html(
      <BranchesPage
        branches={await listBranches(c.env.DB)}
        error="Provide a valid name, address, optional email, currency, and invoice prefix."
        nonce={c.get('secureHeadersNonce')}
      />,
      400
    );
  }
  const branchId = await createBranch(c.env.DB, {
    name,
    business_address: businessAddress,
    business_email: businessEmail || null,
    currency,
    invoice_prefix: invoicePrefix,
  });
  return c.redirect(`/admin/settings?branch=${branchId}`);
});

// ---------- CSV export ----------

function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvResponse(rows: unknown[][], filename: string): Response {
  const body = rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

admin.get('/export/invoices.csv', async (c) => {
  const invoices = await listInvoices(c.env.DB, c.get('branchId'));
  const rows: unknown[][] = [
    ['number', 'client', 'subject', 'status', 'issue_date', 'due_date', 'sent_at', 'paid_at', 'currency', 'subtotal', 'tax', 'total'],
    ...invoices.map((i) => [
      i.number,
      i.client_name,
      i.subject,
      i.status,
      i.issue_date,
      i.due_date,
      i.sent_at,
      i.paid_at,
      i.currency,
      (i.subtotal_cents / 100).toFixed(2),
      (i.tax_cents / 100).toFixed(2),
      (i.total_cents / 100).toFixed(2),
    ]),
  ];
  return csvResponse(rows, 'invoices.csv');
});

admin.get('/export/payments.csv', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.created_at AS date, i.number AS invoice, c.name AS client, p.provider, p.provider_ref,
            p.amount_cents, p.currency, p.note, p.undone_at
     FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id
     WHERE i.branch_id = ?
     ORDER BY p.id`
  ).bind(c.get('branchId')).all<{
    date: string;
    invoice: string;
    client: string;
    provider: string;
    provider_ref: string | null;
    amount_cents: number;
    currency: string;
    note: string | null;
    undone_at: string | null;
  }>();
  const rows: unknown[][] = [
    ['date', 'invoice', 'client', 'provider', 'reference', 'amount', 'currency', 'note', 'undone_at'],
    ...results.map((p) => [
      p.date,
      p.invoice,
      p.client,
      p.provider,
      p.provider_ref,
      (p.amount_cents / 100).toFixed(2),
      p.currency,
      p.note,
      p.undone_at,
    ]),
  ];
  return csvResponse(rows, 'payments.csv');
});

// Remove a recorded pay-link view (own views, email scanners) from History.
admin.post('/invoices/:id/events/:eventId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const eventId = Number(c.req.param('eventId'));
  if (!Number.isInteger(id) || !Number.isInteger(eventId)) return c.notFound();
  if (!(await getInvoiceById(c.env.DB, id))) return c.notFound();
  await deleteViewEvent(c.env.DB, id, eventId);
  return c.redirect(`/admin/invoices/${id}`);
});

// ---------- Payments ----------

admin.get('/payments', async (c) => {
  const branchId = c.get('branchId');
  const clientId = Number(c.req.query('client')) || null;
  const [payments, settings, clients] = await Promise.all([
    listAllPayments(c.env.DB, branchId, clientId),
    getSettings(c.env.DB, branchId),
    listClients(c.env.DB, true),
  ]);
  return c.html(
    <PaymentsPage
      currentPath="/admin/payments"
      payments={payments}
      timezone={settings.timezone}
      currency={settings.currency}
      clients={clients}
      clientId={clientId}
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

// ---------- Reports ----------

admin.get('/reports', async (c) => {
  const branchId = c.get('branchId');
  const settings = await getSettings(c.env.DB, branchId);
  const clientId = Number(c.req.query('client')) || null;
  const [summary, months, clients] = await Promise.all([
    reportSummary(c.env.DB, branchId, todayInTz(settings.timezone), clientId),
    monthlyReport(c.env.DB, branchId, clientId),
    listClients(c.env.DB, true),
  ]);
  return c.html(
    <ReportsPage
      currentPath="/admin/reports"
      summary={summary}
      months={months}
      currency={settings.currency}
      clients={clients}
      clientId={clientId}
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

// ---------- Settings ----------

type Theme = 'auto' | 'light' | 'dark';

/** Display preference, per browser — a cookie, not a Settings (D1) column, so
 *  the server renders the right theme with no flash and no prop threading. */
function themeCookie(c: Context<AppEnv>): Theme {
  const v = getCookie(c, 'theme');
  return v === 'light' || v === 'dark' ? v : 'auto';
}

admin.post('/settings/appearance', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string>;
  const theme: Theme = body.theme === 'light' || body.theme === 'dark' ? body.theme : 'auto';
  setCookie(c, 'theme', theme, { path: '/admin', maxAge: 60 * 60 * 24 * 365, sameSite: 'Lax' });
  return c.redirect('/admin/settings?saved=1#appearance');
});

admin.get('/settings', async (c) => {
  const branches = await listBranches(c.env.DB);
  const requestedBranchId = Number(c.req.query('branch'));
  const branchId = branches.some((branch) => branch.id === requestedBranchId)
    ? requestedBranchId
    : c.get('branchId');
  // Lazy migration: re-encrypt any plaintext stored keys once a master key exists.
  await encryptStoredSecrets(c.env.DB, c.env, await getSettings(c.env.DB, branchId));
  const settings = await getSettings(c.env.DB, branchId);
  const saved = c.req.query('saved') === '1';
  const tzKept = c.req.query('tz_kept') === '1';
  const curKept = c.req.query('cur_kept') === '1';
  const numKept = c.req.query('num_kept') === '1';
  const emailTestOk = c.req.query('email_test') ?? null;
  const emailTestErr = c.req.query('email_test_err') ?? null;
  const resendKept = c.req.query('resend_kept') === '1';
  const secretSaveBlocked = c.req.query('secret_key_required') === '1';
  const accentKeptQ = c.req.query('accent_kept') === '1';
  // Masked-field hints show the last 4 chars of the real key, so boxed values
  // are opened first; undecryptable ones fall back to '' (alert explains why).
  const tail = async (v: string) => {
    const opened = await unbox(c.env.SETTINGS_MASTER_KEY, v.trim());
    return opened ? opened.slice(-4) : '';
  };
  const secretMeta = {
    sources: { resend: keySource(c.env.RESEND_API_KEY, settings.resend_api_key) },
    hints: { resend: await tail(settings.resend_api_key) },
  };
  return c.html(
    <SettingsPage
      currentPath="/admin/settings"
      settings={settings}
      saved={saved}
      tzKept={tzKept}
      curKept={curKept}
      numKept={numKept}
      secretMeta={secretMeta}
      hasLogo={!!(await getLogo(c.env.DB, branchId))}
      emailTestOk={emailTestOk}
      emailTestErr={emailTestErr}
      resendKept={resendKept}
      secretSaveBlocked={secretSaveBlocked}
      accentKept={accentKeptQ}
      alerts={await configWarnings(c.env, settings)}
      theme={themeCookie(c)}
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

admin.post('/settings', async (c) => {
  const raw = await c.req.parseBody();
  const body = raw as Record<string, string>;
  const branchId = Number(body.branch_id);
  if (!(await listBranches(c.env.DB)).some((branch) => branch.id === branchId)) {
    return c.text('Choose a valid company.', 400);
  }
  const current = await getSettings(c.env.DB, branchId);

  // Logo: uploaded file (stored in D1, wins over the URL) or explicit removal.
  const logoFile = raw.logo_file;
  if (logoFile instanceof File && logoFile.size > 0) {
    const mime = logoFile.type === 'image/png' ? 'image/png' : logoFile.type === 'image/jpeg' ? 'image/jpeg' : null;
    if (!mime) return c.text('Logo must be a PNG or JPEG.', 400);
    if (logoFile.size > 500 * 1024) return c.text('Logo must be under 500 KB.', 400);
    await setLogo(c.env.DB, branchId, new Uint8Array(await logoFile.arrayBuffer()), mime);
  } else if (body.remove_logo) {
    await deleteLogo(c.env.DB, branchId);
  }
  const taxRateBps = Math.round(parseFloat(body.tax_rate_percent) * 100);
  // A typo in the free-text timezone keeps the previous value, never resets to UTC.
  const tzValid = !!body.timezone && isValidTimezone(body.timezone);
  const curValid = isSupportedCurrency((body.currency ?? '').toUpperCase());
  const nextNum = parseInt(body.next_invoice_number, 10);
  const numValid = Number.isInteger(nextNum) && nextNum >= 1;

  const accentKept = !!body.accent_color && !accentUsable(body.accent_color);
  await updateSettings(c.env.DB, branchId, {
    business_name: body.business_name,
    business_address: body.business_address,
    business_email: body.business_email || null,
    logo_url: body.logo_url || null,
    currency: curValid ? body.currency.toUpperCase() : current.currency,
    tax_rate_bps: Number.isFinite(taxRateBps) ? taxRateBps : 0,
    invoice_prefix: body.invoice_prefix,
    default_rate_cents: (body.default_rate && parseAmountToCents(body.default_rate)) || 0,
    default_payment_details: body.default_payment_details ?? current.default_payment_details,
    timezone: tzValid ? body.timezone : current.timezone,
    locale: validLocaleTag(submittedLocale(body)) ? submittedLocale(body)!.trim() : current.locale,
    accent_color: accentUsable(body.accent_color) ? safeAccent(body.accent_color) : current.accent_color,
    // Email settings live in their own card/form — preserve as-is here
    email_provider: current.email_provider,
    email_from: current.email_from,
    payment_terms_days: Math.max(0, parseInt(body.payment_terms_days, 10) || 0),
  });
  if (numValid && nextNum !== current.next_invoice_number) {
    await setNextInvoiceNumber(c.env.DB, branchId, nextNum);
  }

  return c.redirect(
    `/admin/settings?branch=${branchId}&saved=1${accentKept ? '&accent_kept=1' : ''}${tzValid ? '' : '&tz_kept=1'}${curValid ? '' : '&cur_kept=1'}${
      numValid ? '' : '&num_kept=1'
    }`
  );
});

admin.post('/settings/email', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string>;
  const current = await getSettings(c.env.DB, c.get('branchId'));
  const submittedKey = (body.resend_api_key ?? '').trim(); // masked field: blank = keep stored
  if (submittedKey && !validMasterKey(c.env.SETTINGS_MASTER_KEY)) {
    return c.redirect('/admin/settings?secret_key_required=1#email');
  }
  let provider: 'resend' | 'none' | 'cloudflare' =
    body.email_provider === 'resend' ? 'resend' : body.email_provider === 'none' ? 'none' : 'cloudflare';
  // Resend without ANY key (submitted, stored, or env secret) would make every
  // email fail — keep the previous provider instead of saving a broken config.
  // The stored key must actually DECRYPT (effectiveProviderEnv), not merely
  // exist: undecryptable ciphertext is not a usable credential.
  const resendKeyAvailable =
    secretConfigured(submittedKey) || !!(await effectiveProviderEnv(c.env, current)).RESEND_API_KEY;
  const resendKept = provider === 'resend' && !resendKeyAvailable;
  if (resendKept) provider = current.email_provider;

  await updateEmailSettings(c.env.DB, {
    email_provider: provider,
    email_from: (body.email_from ?? '').trim(),
    reminders_enabled: body.reminders_enabled ? 1 : 0,
    // Normalized on save so the cron and the UI always agree on the cadence
    reminder_schedule: parseSchedule(body.reminder_schedule ?? '').join(', '),
  });
  if (submittedKey) await setResendApiKey(c.env.DB, await sealIfKeyed(c.env.SETTINGS_MASTER_KEY, submittedKey));
  return c.redirect(resendKept ? '/admin/settings?saved=1&resend_kept=1' : '/admin/settings?saved=1');
});

admin.post('/settings/test-email', async (c) => {
  try {
    const to = await sendTestEmail(c.env, c.env.DB, c.get('branchId'));
    return c.redirect(`/admin/settings?email_test=${encodeURIComponent(to)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.redirect(`/admin/settings?email_test_err=${encodeURIComponent(msg.slice(0, 200))}`);
  }
});
