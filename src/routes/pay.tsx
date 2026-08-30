import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import {
  awaitingPaymentReview,
  getInvoiceByToken,
  getInvoiceItems,
  getInvoiceSourcePdf,
  getLogo,
  getPayments,
  getSettings,
  recordInvoiceView,
  updateLastSeenOrigin,
} from '../db/queries';
import { isLocalRequest } from '../lib/admin-auth';
import { invoicePdfFilename } from '../lib/invoice-filename';
import { generateInvoicePdf, pdfResponse } from '../services/pdf';
import { DraftHold, PublicInvoice } from '../views/pay';
import { PrintInvoice } from '../views/print';

export const pay = new Hono<AppEnv>();

// Pay links are unguessable capability URLs — keep them out of indexes and referrers.
pay.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
});

const BOT_UA = /bot|crawl|spider|scan|preview|fetch|monitor|probe|curl|wget|python|java|headless|lighthouse|slurp/i;
// Networks that email scanners open links from (SafeLinks etc.). Deliberately
// NOT Cloudflare/Apple/Akamai/Fastly — iCloud Private Relay egresses there.
const DATACENTER_ASN = /microsoft|azure|amazon|aws|google llc|hetzner|digitalocean|ovh|linode|vultr|oracle|alibaba/i;

/**
 * A view worth recording: a human other than the admin. The CF_Authorization
 * cookie is domain-scoped, so the admin's own browser sends it to /pay/* too —
 * its presence means "this is the admin". (Trivially spoofable to opt out of
 * tracking; that's fine, it's analytics, not security.)
 */
function classifyView(c: Context<AppEnv>): { record: boolean; geo: string | null } {
  const cookie = c.req.header('Cookie') ?? '';
  const ua = c.req.header('User-Agent') ?? '';
  const cf = (c.req.raw as { cf?: { city?: string; region?: string; country?: string; asOrganization?: string } }).cf;
  const record =
    !cookie.includes('CF_Authorization=') && !!ua && !BOT_UA.test(ua) && !DATACENTER_ASN.test(cf?.asOrganization ?? '');
  const geo = [cf?.city, cf?.region, cf?.country].filter(Boolean).join(', ') || null;
  return { record, geo };
}

pay.get('/:token', async (c) => {
  const invoice = await getInvoiceByToken(c.env.DB, c.req.param('token'));
  if (!invoice) return c.notFound();
  // Drafts aren't shareable yet — any draft view is the admin previewing.
  const view = classifyView(c);
  if (view.record && invoice.status !== 'draft') {
    c.executionCtx.waitUntil(
      recordInvoiceView(c.env.DB, invoice.id, view.geo).catch((e) => console.error('view tracking failed', e))
    );
  }
  const [items, settings, payments] = await Promise.all([
    getInvoiceItems(c.env.DB, invoice.id),
    getSettings(c.env.DB, invoice.branch_id),
    getPayments(c.env.DB, invoice.id),
  ]);
  // Keep the traffic-derived origin fresh for cron-built pay links (writes
  // only when it changes — effectively once per deployment hostname).
  const origin = new URL(c.req.url).origin;
  if (origin !== settings.last_seen_origin && !isLocalRequest(c.req.raw)) {
    c.executionCtx.waitUntil(updateLastSeenOrigin(c.env.DB, origin));
  }
  if (invoice.status === 'draft') {
    return c.html(<DraftHold invoice={invoice} settings={settings} nonce={c.get('secureHeadersNonce')} />);
  }
  const underReview = awaitingPaymentReview(invoice, payments);
  return c.html(
    <PublicInvoice
      invoice={invoice}
      items={items}
      settings={settings}
      underReview={underReview}
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

pay.get('/:token/print', async (c) => {
  const invoice = await getInvoiceByToken(c.env.DB, c.req.param('token'));
  if (!invoice) return c.notFound();
  if (invoice.status === 'draft') return c.notFound();
  const [items, settings, logo] = await Promise.all([
    getInvoiceItems(c.env.DB, invoice.id),
    getSettings(c.env.DB, invoice.branch_id),
    getLogo(c.env.DB, invoice.branch_id),
  ]);
  return c.html(
    <PrintInvoice
      invoice={invoice}
      items={items}
      settings={settings}
      payUrl={`${c.env.APP_BASE_URL}/pay/${invoice.public_token}`}
      logoSrc={logo ? `/logo/${settings.branch_id}` : settings.logo_url || null}
      nonce={c.get('secureHeadersNonce')}
    />
  );
});

pay.get('/:token/pdf', async (c) => {
  const invoice = await getInvoiceByToken(c.env.DB, c.req.param('token'));
  if (!invoice) return c.notFound();
  if (invoice.status === 'draft') return c.notFound();
  const limiter = c.env.PDF_RATE_LIMITER;
  if (limiter && !(await limiter.limit({ key: invoice.public_token })).success) {
    return c.text('Too many PDF requests. Please try again in a minute.', 429);
  }
  const sourcePdf = await getInvoiceSourcePdf(c.env.DB, invoice.id);
  if (sourcePdf) return pdfResponse(sourcePdf.bytes, sourcePdf.filename);
  const [items, settings, logo] = await Promise.all([
    getInvoiceItems(c.env.DB, invoice.id),
    getSettings(c.env.DB, invoice.branch_id),
    getLogo(c.env.DB, invoice.branch_id),
  ]);
  return pdfResponse(
    await generateInvoicePdf(
      invoice,
      items,
      settings,
      c.env.ASSETS,
      logo
    ),
    invoicePdfFilename(settings.branch_id, invoice.issue_date)
  );
});
