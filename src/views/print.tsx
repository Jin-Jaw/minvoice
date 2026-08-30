import { raw } from 'hono/html';
import type { InvoiceItem, InvoiceWithClient, Settings } from '../db/queries';
import { formatTaxRate } from '../lib/money';
import { formatCentsTag, formatDateTag, getStrings, resolveLocale } from '../lib/strings';
import { safeAccent } from '../lib/color';

/**
 * Print-optimized invoice document in the "Register" style — the app's
 * utilitarian language on paper. Deliberately standalone: no app layout, no
 * global stylesheet, so it prints as clean stationery. The toolbar exists on
 * screen only. The invoice subject is deliberately NOT part of the document.
 *
 * The production CSP forbids inline style attributes — every rule lives in
 * the nonce-protected <style> block below.
 */
export function PrintInvoice({
  invoice,
  items,
  settings,
  payUrl,
  logoSrc,
  nonce,
}: {
  invoice: InvoiceWithClient;
  items: InvoiceItem[];
  settings: Settings;
  payUrl: string;
  /** Resolved logo URL (uploaded branch logo preferred), or null to omit. */
  logoSrc?: string | null;
  nonce?: string;
}) {
  const cur = invoice.currency;
  const tag = resolveLocale(settings.locale, invoice.client_locale);
  const t = getStrings(tag);
  const money = (cents: number) => formatCentsTag(cents, cur, tag);
  const stamp = invoice.status === 'paid' ? t.statusPaid : invoice.status === 'void' ? t.statusVoid : null;
  const accent = safeAccent(settings.accent_color);

  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang={tag}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`Invoice ${invoice.number}`}</title>
        <style
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
@font-face {
  font-family: 'Instrument Sans';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url('/fonts/instrument-sans.woff2') format('woff2');
}
:root {
  --paper: #f5f6f7;
  --ink: #1f272b;
  --body: #3d474c;
  --soft: #6e7a81;
  --line: #e4e7e9;
  --rowline: #eef1f2;
  --panel: #f9fafb;
  --accent: ${accent};
  --rust: #b03a27;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: 'Instrument Sans', 'Segoe UI', system-ui, sans-serif;
  font-size: 13.5px;
  line-height: 1.5;
}
.toolbar {
  max-width: 794px;
  margin: 0 auto;
  padding: 16px 24px 0;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.toolbar a, .toolbar button {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  background: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  text-decoration: none;
}
.toolbar button { background: var(--accent); border-color: var(--accent); color: #fff; }
.sheet {
  max-width: 794px;
  margin: 16px auto 48px;
  background: #ffffff;
  border: 1px solid var(--line);
  box-shadow: 0 2px 24px rgba(31, 39, 43, 0.08);
  padding: 56px 60px;
  position: relative;
}
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
.brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.brand-logo { display: block; max-height: 48px; max-width: 120px; border-radius: 8px; }
.biz-name { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
.biz-contact { color: var(--soft); font-size: 12px; white-space: pre-line; margin-top: 2px; }
.doc-id { text-align: right; flex-shrink: 0; }
.doc-title { font-size: 26px; font-weight: 700; letter-spacing: 0.08em; margin: 0; }
.doc-number { font-size: 14px; font-weight: 600; color: var(--soft); margin: 2px 0 0; font-variant-numeric: tabular-nums; }
.meta {
  display: flex;
  gap: 40px;
  padding: 14px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  margin: 26px 0 28px;
}
.meta > div { min-width: 0; }
.meta-billed { flex: 1 1 auto; }
.meta dt {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--soft);
  margin: 0 0 3px;
}
.meta dd { margin: 0; font-size: 14px; font-variant-numeric: tabular-nums; }
.meta-billed dd { font-weight: 650; }
.billed-contact { font-size: 12.5px; font-weight: 400; color: var(--soft); white-space: pre-line; margin-top: 2px; }
.meta-amount dd { font-weight: 700; }
table { width: 100%; border-collapse: separate; border-spacing: 0; }
thead { display: table-header-group; /* repeats the dark header on every printed page */ }
th {
  text-align: left;
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #ffffff;
  background: var(--ink);
  padding: 9px 12px;
}
th:first-child { border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
th:last-child { border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
td { padding: 12px; border-bottom: 1px solid var(--rowline); vertical-align: top; }
tr { break-inside: avoid; }
td.desc { white-space: pre-line; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
/* Qty/unit are supporting math — the amount column carries the row */
.num.dim { color: var(--soft); }
td.amount { font-weight: 600; }
.totals { margin-left: auto; width: 280px; margin-top: 18px; font-variant-numeric: tabular-nums; }
.totals-row { display: flex; justify-content: space-between; padding: 4px 0; color: var(--soft); }
.totals-row span:last-child { color: var(--ink); }
.totals-final {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 2px solid var(--ink);
  font-size: 17px;
  font-weight: 700;
}
.payment { margin-top: 30px; background: var(--panel); border: 1px solid var(--rowline); border-radius: 8px; padding: 16px 18px; break-inside: avoid; }
.payment-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--soft);
}
.payment p { margin: 6px 0 0; white-space: pre-line; font-size: 13px; color: var(--body); }
.doc-footer {
  margin-top: 40px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 24px;
  font-size: 12px;
  color: var(--soft);
  break-inside: avoid;
}
.stamp {
  position: absolute;
  top: 120px;
  right: 60px;
  transform: rotate(-8deg);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 6px 16px;
  border: 3px solid;
  border-radius: 6px;
}
.stamp-paid { color: var(--accent); border-color: var(--accent); }
.stamp-void { color: var(--rust); border-color: var(--rust); }
@page { size: A4; margin: 14mm 16mm; }
@media print {
  body { background: #fff; }
  .toolbar { display: none; }
  .sheet {
    max-width: none;
    margin: 0;
    padding: 0;
    border: none;
    box-shadow: none;
  }
  .stamp { top: 64px; right: 0; }
}
`,
          }}
        ></style>
      </head>
      <body>
        <div class="toolbar">
          <a href={payUrl}>{t.viewOnline}</a>
          <button type="button" id="print-button">
            {t.print}
          </button>
        </div>
        <div class="sheet">
          {stamp ? <span class={`stamp stamp-${invoice.status}`}>{stamp}</span> : null}

          <header class="head">
            <div class="brand">
              {logoSrc ? <img class="brand-logo" src={logoSrc} alt="" /> : null}
              <div>
                <h1 class="biz-name">{settings.business_name}</h1>
                <div class="biz-contact">
                  {settings.business_address || ''}
                  {settings.business_email ? `\n${settings.business_email}` : ''}
                </div>
              </div>
            </div>
            <div class="doc-id">
              <p class="doc-title">{t.invoice.toLocaleUpperCase(tag)}</p>
              <p class="doc-number">{invoice.number}</p>
            </div>
          </header>

          <dl class="meta">
            <div class="meta-billed">
              <dt>{t.billedTo}</dt>
              <dd>
                {invoice.client_name}
                {invoice.client_address || invoice.client_email ? (
                  <div class="billed-contact">
                    {[invoice.client_address, invoice.client_email].filter(Boolean).join('\n')}
                  </div>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>{t.issued}</dt>
              <dd>{formatDateTag(invoice.issue_date, tag)}</dd>
            </div>
            {invoice.due_date ? (
              <div>
                <dt>{t.due}</dt>
                <dd>{formatDateTag(invoice.due_date, tag)}</dd>
              </div>
            ) : null}
            {invoice.paid_at ? (
              <div>
                <dt>{t.paid}</dt>
                <dd>{formatDateTag(invoice.paid_at.slice(0, 10), tag)}</dd>
              </div>
            ) : null}
            <div class="meta-amount">
              <dt>{t.amountDue}</dt>
              <dd>{money(invoice.total_cents)}</dd>
            </div>
          </dl>

          <table>
            <thead>
              <tr>
                <th>{t.description}</th>
                <th class="num">{t.qty}</th>
                <th class="num">{t.unitPrice}</th>
                <th class="num">{t.amount}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr>
                  <td class="desc">{it.description}</td>
                  <td class="num dim">{it.quantity}</td>
                  <td class="num dim">{money(it.unit_price_cents)}</td>
                  <td class="num amount">{money(it.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div class="totals">
            <div class="totals-row">
              <span>{t.subtotal}</span>
              <span>{money(invoice.subtotal_cents)}</span>
            </div>
            <div class="totals-row">
              <span>{t.tax} ({formatTaxRate(invoice.tax_rate_bps)})</span>
              <span>{money(invoice.tax_cents)}</span>
            </div>
            <div class="totals-final">
              <span>{t.total}</span>
              <span>{money(invoice.total_cents)}</span>
            </div>
          </div>

          {invoice.notes ? (
            <div class="payment">
              <span class="payment-label">{t.paymentDetails}</span>
              <p>{invoice.notes}</p>
            </div>
          ) : null}

          <div class="doc-footer">
            <span>{t.footerThanks(settings.business_name || null)}</span>
          </div>

        </div>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
document.getElementById('print-button')?.addEventListener('click', function () { window.print(); });

// ?auto=1 (the {t.print} buttons elsewhere in the app) opens the dialog
// immediately — but only after fonts load, so the paper copy isn't a fallback face.
if (new URLSearchParams(location.search).get('auto') === '1') {
  document.fonts.ready.then(function () { setTimeout(function () { window.print(); }, 50); });
}
`,
          }}
        ></script>
      </body>
      </html>
    </>
  );
}
