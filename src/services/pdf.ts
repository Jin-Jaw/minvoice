import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { InvoiceItem, InvoiceWithClient, Logo, Settings } from '../db/queries';
import { formatTaxRate } from '../lib/money';
import { formatCentsTag, formatDateTag, getStrings, resolveLocale } from '../lib/strings';
import { hexToRgb01 } from '../lib/color';

// A4, "Register" palette — mirrors public/styles.css. Sizes are pt (px × 0.75).
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 45; // ~60px side margins
const TOP = PAGE.height - 42; // ~56px top margin
const FOOTER_FLOOR = 88; // content never draws below this — footer space is reserved
const COL = {
  desc: MARGIN,
  qtyRight: 390,
  unitRight: 468,
  amountRight: PAGE.width - MARGIN,
};
const CELL_INSET = 9; // 12px cell padding inside the table
const INK = rgb(0.122, 0.153, 0.169); // #1f272b
const BODY = rgb(0.239, 0.278, 0.298); // #3d474c
const SOFT = rgb(0.431, 0.478, 0.506); // #6e7a81
const LINE = rgb(0.894, 0.906, 0.914); // #e4e7e9
const ROWLINE = rgb(0.933, 0.945, 0.949); // #eef1f2
const PANEL = rgb(0.976, 0.98, 0.984); // #f9fafb
const WHITE = rgb(1, 1, 1);
const RUST = rgb(0.69, 0.227, 0.153); // #b03a27

type Ctx = {
  doc: PDFDocument;
  page: ReturnType<PDFDocument['addPage']>;
  regular: PDFFont;
  bold: PDFFont;
  y: number;
};

/**
 * Noto Sans (Latin + Greek + Cyrillic) served from the static assets binding —
 * assets don't count toward Worker script size, and `subset: true` embeds only
 * used glyphs per document. Font BYTES are cached per isolate; each
 * PDFDocument still embeds its own copy (pdf-lib requirement). Any failure
 * here falls back to the WinAnsi standard fonts, which keeps PDFs rendering
 * (Latin-1 only) even if a fork drops the font files.
 */
const FONT_PATHS = {
  regular: '/fonts/pdf/NotoSans-Regular.ttf',
  bold: '/fonts/pdf/NotoSans-Bold.ttf',
} as const;
let fontBytesPromise: Promise<Record<keyof typeof FONT_PATHS, ArrayBuffer> | null> | null = null;

function loadFontBytes(assets: Fetcher | undefined) {
  if (!assets) return Promise.resolve(null);
  fontBytesPromise ??= (async () => {
    try {
      const entries = await Promise.all(
        (Object.keys(FONT_PATHS) as (keyof typeof FONT_PATHS)[]).map(async (k) => {
          const res = await assets.fetch(`https://assets.local${FONT_PATHS[k]}`);
          if (!res.ok) throw new Error(`font ${FONT_PATHS[k]}: ${res.status}`);
          return [k, await res.arrayBuffer()] as const;
        })
      );
      return Object.fromEntries(entries) as Record<keyof typeof FONT_PATHS, ArrayBuffer>;
    } catch (e) {
      console.error('PDF fonts unavailable, falling back to standard fonts', e);
      return null;
    }
  })();
  return fontBytesPromise;
}

async function embedFonts(doc: PDFDocument, assets: Fetcher | undefined) {
  const bytes = await loadFontBytes(assets);
  if (!bytes) {
    return {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
  }
  doc.registerFontkit(fontkit);
  return {
    regular: await doc.embedFont(bytes.regular, { subset: true }),
    bold: await doc.embedFont(bytes.bold, { subset: true }),
  };
}

/** Filled (optionally bordered) rectangle with rounded corners — pdf-lib has no native radius. */
function roundedRect(
  page: PDFPage,
  x: number,
  topY: number,
  w: number,
  h: number,
  r: number,
  fill: ReturnType<typeof rgb>,
  border?: { color: ReturnType<typeof rgb>; width: number }
) {
  const path =
    `M ${r},0 H ${w - r} A ${r},${r} 0 0 1 ${w},${r} V ${h - r} ` +
    `A ${r},${r} 0 0 1 ${w - r},${h} H ${r} A ${r},${r} 0 0 1 0,${h - r} ` +
    `V ${r} A ${r},${r} 0 0 1 ${r},0 Z`;
  page.drawSvgPath(path, {
    x,
    y: topY,
    color: fill,
    ...(border ? { borderColor: border.color, borderWidth: border.width } : {}),
  });
}

export async function generateInvoicePdf(
  invoice: InvoiceWithClient,
  items: InvoiceItem[],
  settings: Settings,
  assets?: Fetcher,
  logo?: Logo | null,
  payUrl?: string
): Promise<Uint8Array> {
  const tag = resolveLocale(settings.locale, invoice.client_locale);
  const t = getStrings(tag);
  // Intl emits U+00A0/U+202F group separators (e.g. French '1 234,56 €');
  // normalize to plain spaces so formatted amounts stay WinAnsi-encodable.
  const deSpace = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
  const money = (cents: number) => deSpace(formatCentsTag(cents, invoice.currency, tag));
  const date = (iso: string) => deSpace(formatDateTag(iso, tag));
  const a = hexToRgb01(settings.accent_color);
  const ACCENT = rgb(a.r, a.g, a.b);

  // Free-plan CPU: embedding + subsetting the Noto fonts costs ~130ms CPU vs
  // ~3.5ms for the WinAnsi built-ins — far beyond the Workers Free 10ms cap.
  // Every built-in locale (en/es/de/fr incl. umlauts, accents, €) fits
  // WinAnsi, so embed the Unicode fonts ONLY when the document's actual text
  // needs them (Cyrillic, Greek, extended Latin like Polish).
  // Collect the EXACT strings that will be drawn — including locale-aware
  // uppercasing (Turkish 'İ' is not WinAnsi) and every formatted date the
  // document can contain (a Polish paid date renders 'paź').
  // The invoice subject is deliberately NOT part of the document.
  const upper = (v: string) => v.toLocaleUpperCase(tag);
  const documentText = [
    t.invoice, upper(t.invoice),
    ...[t.billedTo, t.description, t.qty, t.unitPrice, t.amount, t.amountDue, t.issued, t.due, t.paymentDetails].map(upper),
    t.subtotal, t.tax, t.total,
    t.statusPaid, t.statusVoid,
    t.footerThanks(settings.business_name || null),
    settings.business_name, settings.business_address, settings.business_email ?? '',
    invoice.number, invoice.client_name, invoice.client_email ?? '', invoice.client_address ?? '', invoice.notes ?? '',
    date(invoice.issue_date),
    invoice.due_date ? date(invoice.due_date) : '',
    invoice.paid_at ? date(invoice.paid_at.slice(0, 10)) : '',
    money(invoice.total_cents),
    payUrl ?? '',
    ...items.map((it) => it.description),
  ].join('');
  const needsUnicodeFonts = ![...documentText].every(
    (ch) => ch.charCodeAt(0) <= 0xff || CP1252_EXTRAS.has(ch)
  );

  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc, needsUnicodeFonts ? assets : undefined);
  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE.width, PAGE.height]),
    ...fonts,
    y: TOP,
  };
  doc.setTitle(`${t.invoice} ${invoice.number}`);
  if (settings.business_name) doc.setAuthor(settings.business_name);

  const text = (
    str: string,
    x: number,
    opts: {
      size?: number;
      font?: PDFFont;
      color?: ReturnType<typeof rgb>;
      rightAlignTo?: number;
    } = {}
  ) => {
    const font = opts.font ?? ctx.regular;
    const size = opts.size ?? 10;
    const safe = sanitize(str, font);
    const drawX =
      opts.rightAlignTo !== undefined ? opts.rightAlignTo - font.widthOfTextAtSize(safe, size) : x;
    ctx.page.drawText(safe, { x: drawX, y: ctx.y, size, font, color: opts.color ?? INK });
  };

  // 11px/700 uppercase labels in muted ink
  const label = (str: string, x: number, rightAlignTo?: number) =>
    text(str.toLocaleUpperCase(tag), x, { size: 8, font: ctx.bold, color: SOFT, rightAlignTo });

  const hr = (color = LINE, x1 = MARGIN, x2 = PAGE.width - MARGIN, thickness = 0.75) =>
    ctx.page.drawLine({ start: { x: x1, y: ctx.y }, end: { x: x2, y: ctx.y }, thickness, color });

  // ---- Header: logo + identity left, INVOICE + number right ----
  // Routes pass the uploaded full artwork here. The URL is only a fallback;
  // the square email asset is never substituted for an available full logo.
  const logoImage = await tryEmbedLogo(doc, logo ?? settings.logo_url);
  let identityX = MARGIN;
  if (logoImage) {
    const dims = logoImage.scaleToFit(84, 36);
    ctx.page.drawImage(logoImage, { x: MARGIN, y: TOP - dims.height, width: dims.width, height: dims.height });
    identityX = MARGIN + dims.width + 10;
  }
  ctx.y = TOP - 13;
  const identityWidth = 350 - identityX;
  const businessLines = wrapText(settings.business_name || t.invoice, ctx.bold, 13.5, identityWidth);
  for (const [index, line] of businessLines.entries()) {
    if (index) ctx.y -= 15;
    text(line, identityX, { size: 13.5, font: ctx.bold });
  }
  const identityLines = (settings.business_address || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => wrapText(line, ctx.regular, 9, identityWidth));
  if (settings.business_email) identityLines.push(...wrapText(settings.business_email, ctx.regular, 9, identityWidth));
  for (const [index, line] of identityLines.entries()) {
    ctx.y -= index === 0 ? 14 : 11;
    text(line, identityX, { size: 9, color: SOFT });
  }
  const leftEndY = ctx.y;
  ctx.y = TOP - 17;
  text(upper(t.invoice), 0, { size: 19.5, font: ctx.bold, rightAlignTo: COL.amountRight });
  ctx.y -= 15;
  text(invoice.number, 0, { size: 10.5, font: ctx.bold, color: SOFT, rightAlignTo: COL.amountRight });
  ctx.y = Math.min(leftEndY, ctx.y, TOP - 40) - 20;

  // ---- Meta band: billed-to + dates + amount due between hairlines ----
  hr();
  ctx.y -= 16;
  const issuedX = 330;
  const dueX = 415;
  label(t.billedTo, MARGIN);
  label(t.issued, issuedX);
  if (invoice.due_date) label(t.due, dueX);
  label(t.amountDue, 0, COL.amountRight);
  ctx.y -= 14;
  text(truncate(invoice.client_name, ctx.bold, 10.5, issuedX - MARGIN - 14), MARGIN, {
    size: 10.5,
    font: ctx.bold,
  });
  text(date(invoice.issue_date), issuedX);
  if (invoice.due_date) text(date(invoice.due_date), dueX);
  text(money(invoice.total_cents), 0, { font: ctx.bold, rightAlignTo: COL.amountRight });
  // client address + email under the name, muted
  const billedLines = [
    ...(invoice.client_address ?? '').split('\n').filter(Boolean),
    ...(invoice.client_email ? [invoice.client_email] : []),
  ];
  for (const line of billedLines) {
    ctx.y -= 11;
    text(truncate(line, ctx.regular, 9, issuedX - MARGIN - 14), MARGIN, { size: 9, color: SOFT });
  }
  ctx.y -= 14;
  hr();
  ctx.y -= 30;

  // ---- Items table: dark header bar, repeated on every page ----
  const BAR_H = 22;
  const tableHeader = () => {
    roundedRect(ctx.page, MARGIN, ctx.y + 15, PAGE.width - 2 * MARGIN, BAR_H, 4.5, INK);
    const labelBar = (str: string, x: number, rightAlignTo?: number) =>
      text(str.toLocaleUpperCase(tag), x, { size: 8.5, font: ctx.bold, color: WHITE, rightAlignTo });
    labelBar(t.description, COL.desc + CELL_INSET);
    labelBar(t.qty, 0, COL.qtyRight);
    labelBar(t.unitPrice, 0, COL.unitRight);
    labelBar(t.amount, 0, COL.amountRight - CELL_INSET);
    ctx.y -= BAR_H + 12;
  };
  tableHeader();

  for (const item of items) {
    const descLines = wrapText(item.description, ctx.regular, 10, COL.qtyRight - COL.desc - CELL_INSET - 50);
    if (ctx.y < FOOTER_FLOOR + 40 + (descLines.length - 1) * 12) {
      ctx.page = doc.addPage([PAGE.width, PAGE.height]);
      ctx.y = TOP - 15;
      tableHeader();
    }
    // First description line shares the row with the numbers; extra lines follow
    text(descLines[0], COL.desc + CELL_INSET);
    text(String(item.quantity), 0, { rightAlignTo: COL.qtyRight, color: SOFT });
    text(money(item.unit_price_cents), 0, { rightAlignTo: COL.unitRight, color: SOFT });
    text(money(item.amount_cents), 0, { font: ctx.bold, rightAlignTo: COL.amountRight });
    for (const line of descLines.slice(1)) {
      ctx.y -= 12;
      text(line, COL.desc + CELL_INSET, { color: SOFT, size: 9 });
    }
    ctx.y -= 9;
    hr(ROWLINE);
    ctx.y -= 15;
  }

  // ---- Totals: right column with a heavy rule above the total ----
  if (ctx.y < FOOTER_FLOOR + 80) {
    ctx.page = doc.addPage([PAGE.width, PAGE.height]);
    ctx.y = TOP - 15;
  }
  const totalsX = COL.amountRight - 210;
  text(t.subtotal, totalsX, { color: SOFT });
  text(money(invoice.subtotal_cents), 0, { rightAlignTo: COL.amountRight });
  ctx.y -= 15;
  text(`${t.tax} (${formatTaxRate(invoice.tax_rate_bps)})`, totalsX, { color: SOFT });
  text(money(invoice.tax_cents), 0, { rightAlignTo: COL.amountRight });
  ctx.y -= 11;
  hr(INK, totalsX, COL.amountRight, 1.5);
  ctx.y -= 17;
  text(t.total, totalsX, { size: 12.75, font: ctx.bold });
  text(money(invoice.total_cents), 0, {
    size: 12.75,
    font: ctx.bold,
    rightAlignTo: COL.amountRight,
  });

  // ---- Status stamp (PAID / VOID) ----
  if (invoice.status === 'paid' || invoice.status === 'void') {
    const stamp =
      invoice.status === 'paid'
        ? `${t.statusPaid}${invoice.paid_at ? `  ${date(invoice.paid_at.slice(0, 10))}` : ''}`
        : t.statusVoid;
    const color = invoice.status === 'paid' ? ACCENT : RUST;
    ctx.y -= 27;
    const w = ctx.bold.widthOfTextAtSize(sanitize(stamp, ctx.bold), 10) + 20;
    ctx.page.drawRectangle({
      x: COL.amountRight - w,
      y: ctx.y - 7,
      width: w,
      height: 24,
      borderColor: color,
      borderWidth: 1.2,
      opacity: 0,
      borderOpacity: 0.9,
    });
    text(stamp, 0, { size: 10, font: ctx.bold, color, rightAlignTo: COL.amountRight - 10 });
  }

  // ---- Payment details panel (invoice notes) ----
  if (invoice.notes) {
    const panelW = PAGE.width - 2 * MARGIN;
    const bodyLines = invoice.notes
      .split('\n')
      .flatMap((line) => (line.trim() ? wrapText(line, ctx.regular, 9.75, panelW - 28) : ['']));
    const panelH = 13 + 9 + 8 + bodyLines.length * 13 + 10;
    // The 30pt gap above the panel counts toward the fit check — otherwise a
    // panel that barely fits gets pushed into the footer and clips its tail.
    if (ctx.y - 30 - panelH < FOOTER_FLOOR) {
      ctx.page = doc.addPage([PAGE.width, PAGE.height]);
      ctx.y = TOP - 15;
    } else {
      ctx.y -= 30;
    }
    roundedRect(ctx.page, MARGIN, ctx.y + 2, panelW, panelH, 6, PANEL, { color: ROWLINE, width: 0.75 });
    ctx.y -= 13 + 6;
    label(t.paymentDetails, MARGIN + 14);
    ctx.y -= 15;
    for (const line of bodyLines) {
      if (ctx.y < FOOTER_FLOOR - 10) break;
      if (line) text(line, MARGIN + 14, { size: 9.75, color: BODY });
      ctx.y -= 13;
    }
  }

  // ---- Footer pinned to every page: hairline, thanks left, pay link right ----
  const pages = doc.getPages();
  for (const p of pages) {
    ctx.page = p;
    ctx.y = 64;
    hr();
    ctx.y = 50;
    const thanks = t.footerThanks(settings.business_name || null);
    text(thanks, MARGIN, { size: 9, color: SOFT });
    if (payUrl) {
      const thanksW = ctx.regular.widthOfTextAtSize(sanitize(thanks, ctx.regular), 9);
      const linkW = ctx.regular.widthOfTextAtSize(sanitize(payUrl, ctx.regular), 7.5);
      // Long tokens overflow the shared baseline — drop the link a line down.
      if (MARGIN + thanksW + 16 + linkW > COL.amountRight) ctx.y = 38;
      text(payUrl, 0, { size: 7.5, color: ACCENT, rightAlignTo: COL.amountRight });
    }
  }

  return doc.save();
}

export function pdfResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

/** Uploaded logo bytes (preferred) or a settings URL to fetch — either may fail without blocking the invoice. */
async function tryEmbedLogo(doc: PDFDocument, source: Logo | string | null) {
  if (!source) return null;
  try {
    if (typeof source !== 'string') {
      return source.mime === 'image/png' ? await doc.embedPng(source.bytes) : await doc.embedJpg(source.bytes);
    }
    const res = await fetch(source);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    const type = res.headers.get('content-type') ?? '';
    return type.includes('png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    return null; // bad logo never blocks invoice rendering
  }
}

/**
 * Wrap text to a column width, honoring explicit newlines and breaking on
 * spaces (falls back to hard truncation for a single unbreakable word).
 */
function wrapText(str: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of str.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(sanitize(candidate, font), size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return (out.length ? out : ['']).map((l) => truncate(l, font, size, maxWidth));
}

// Printable CP1252 characters above Latin-1 — WinAnsi encodes these fine.
const CP1252_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

// Per-font glyph coverage, cached (getCharacterSet walks the font tables).
const charSets = new WeakMap<PDFFont, Set<number> | null>();
function fontCharSet(font: PDFFont): Set<number> | null {
  if (!charSets.has(font)) {
    try {
      charSets.set(font, new Set(font.getCharacterSet()));
    } catch {
      charSets.set(font, null); // standard fonts: fall back to CP1252 filtering
    }
  }
  return charSets.get(font) ?? null;
}

/**
 * Replace characters the font can't draw with '?'. The embedded Noto fonts
 * cover Latin, Greek, and Cyrillic; the standard-font fallback covers
 * WinAnsi. Either way the PDF renders instead of pdf-lib throwing on an
 * unencodable character.
 */
function sanitize(str: string, font: PDFFont): string {
  const set = fontCharSet(font);
  if (set) {
    return [...str].map((ch) => (set.has(ch.codePointAt(0)!) || ch === ' ' ? ch : '?')).join('');
  }
  return [...str].map((ch) => (ch.charCodeAt(0) <= 0xff || CP1252_EXTRAS.has(ch) ? ch : '?')).join('');
}

/** Sanitize for the font, then ellipsize overflow to fit the column. */
function truncate(str: string, font: PDFFont, size: number, maxWidth: number): string {
  let s = sanitize(str, font);
  if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
  while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxWidth) s = s.slice(0, -1);
  return s + '…';
}
