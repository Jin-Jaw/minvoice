import { Hono, type Context } from 'hono';
import type { AppEnv, Bindings } from './env';
import { sendOverdueReminders } from './services/reminders';
import { accessMiddleware } from './middleware/access';
import { csrfGuard } from './middleware/csrf';
import { branchContext } from './middleware/branch';
import { admin } from './routes/admin';
import { pay } from './routes/pay';
import {
  clearLoginAttempts,
  getInvoiceById,
  getInvoiceItems,
  getInvoiceSourcePdf,
  getLogo,
  getSettings,
  purgeOldLoginAttempts,
  purgeOldOutbox,
  recordLoginAttempt,
} from './db/queries';
import { processEmailOutbox } from './services/outbox';
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MINUTES, MAX_OUTBOX_ATTEMPTS } from './lib/outbox';
import { generateInvoicePdf, pdfResponse } from './services/pdf';
import { sendErrorAlert } from './services/email';
import { NotFoundPage } from './views/error';
import { AuthSetupPage, LoginPage } from './views/admin/login';
import { PrintInvoice } from './views/print';
import {
  authMode,
  isLocalRequest,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signSession,
  timingSafeEqual,
} from './lib/admin-auth';
import { resolveBaseUrl } from './lib/base-url';
import { invoicePdfFilename } from './lib/invoice-filename';
import { deleteCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { redactSensitivePath } from './lib/redact';
import { NONCE, secureHeaders } from 'hono/secure-headers';

const app = new Hono<AppEnv>();

// A fresh nonce on every response permits only the small, server-rendered
// scripts/styles emitted by this app. Inline event/style attributes remain
// forbidden, which keeps stored invoice/client text inert in the browser.
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", NONCE],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", NONCE],
      styleSrcAttr: ["'none'"],
      workerSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: 'same-origin',
    crossOriginResourcePolicy: 'same-origin',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
    xFrameOptions: 'DENY',
    referrerPolicy: 'same-origin',
    permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [] },
  })
);

// Financial records and capability-token invoice pages should never be
// framed, indexed, MIME-sniffed, or retained in shared browser/proxy caches.
app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Robots-Tag', 'noindex, nofollow');
});

// Zero-config base URL: when APP_BASE_URL isn't set (workers.dev / one-click
// deploys), derive it per request so emails, checkout redirects, and PDF
// links point at wherever the app is actually served.
app.use('*', async (c, next) => {
  const resolved = resolveBaseUrl(c.env.APP_BASE_URL, c.req.url, isLocalRequest(c.req.raw));
  if (resolved !== c.env.APP_BASE_URL) c.env = { ...c.env, APP_BASE_URL: resolved };
  await next();
});

app.get('/', (c) => c.redirect('/admin'));

// Cap admin request bodies BEFORE any handler buffers them. Expense evidence
// gets a narrowly scoped 2 MB envelope (the verified file itself is capped at
// 1.5 MB for D1); every other admin action keeps the tighter 1 MB limit.
const standardAdminBodyLimit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => c.text('Request body too large (1 MB limit).', 413),
});
const expenseEvidenceBodyLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (c) => c.text('Request body too large (2 MB limit).', 413),
});
app.use('/admin/*', (c, next) =>
  (c.req.path.startsWith('/admin/expenses') ? expenseEvidenceBodyLimit : standardAdminBodyLimit)(c, next)
);

// CSRF: reject cross-site state-changing requests to any admin route (incl.
// login). Registered before the routes below so it covers them all.
app.use('/admin/*', csrfGuard);

// ---- Login/logout: registered BEFORE the /admin/* auth middleware so they're
// reachable while signed out. In access mode they defer to Access entirely.
app.get('/admin/login', (c) => {
  const mode = authMode(c.env);
  if (mode === 'access') return c.redirect('/admin');
  if (mode === 'unconfigured') return c.html(<AuthSetupPage nonce={c.get('secureHeadersNonce')} />, 403);
  return c.html(<LoginPage loggedOut={c.req.query('out') === '1'} nonce={c.get('secureHeadersNonce')} />);
});

app.post('/admin/login', async (c) => {
  if (authMode(c.env) !== 'password') return c.redirect('/admin');

  // Rate limit BEFORE the password check: every POST atomically consumes one
  // of 10 attempts per IP per 15 minutes (upsert + RETURNING in one D1
  // statement), so parallel requests each get a distinct count and can't all
  // observe a below-limit counter. Success clears the row.
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if ((await recordLoginAttempt(c.env.DB, ip, LOGIN_WINDOW_MINUTES)) > LOGIN_MAX_ATTEMPTS) {
    return c.html(<LoginPage lockedOut nonce={c.get('secureHeadersNonce')} />, 429);
  }

  const body = await c.req.parseBody();
  const password = typeof body.password === 'string' ? body.password : '';
  if (password && (await timingSafeEqual(password, c.env.ADMIN_PASSWORD!))) {
    c.executionCtx.waitUntil(clearLoginAttempts(c.env.DB, ip));
    const expiresAt = Date.now() + SESSION_TTL_MS;
    setCookie(c, SESSION_COOKIE, await signSession(c.env.ADMIN_PASSWORD!, expiresAt), {
      path: '/',
      httpOnly: true,
      // Secure except plain-http local dev — Safari drops Secure cookies on
      // http://localhost (no Chrome-style exception), which breaks login there.
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      expires: new Date(expiresAt),
    });
    return c.redirect('/admin');
  }
  await new Promise((r) => setTimeout(r, 800)); // per-request friction on top of the counter
  return c.html(<LoginPage error nonce={c.get('secureHeadersNonce')} />, 401);
});

app.get('/admin/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  // Access sessions end at the edge; password sessions end with the cookie.
  if (authMode(c.env) === 'access') return c.redirect('/cdn-cgi/access/logout');
  return c.redirect('/admin/login?out=1');
});

// Uptime probe: 200 only when the Worker AND its database answer. Public by
// design — exempt this path from WAF ASN blocks so external monitors reach it.
app.get('/health', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.text('ok');
  } catch (e) {
    console.error('health check failed', e);
    return c.text('unhealthy', 503);
  }
});

// Uploaded branch logo (public: appears on client-facing pages and emails).
async function serveLogo(c: Context<AppEnv>, branchId: number) {
  const logo = await getLogo(c.env.DB, branchId);
  if (!logo) return c.notFound();
  return new Response(logo.bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': logo.mime,
      'Cache-Control': 'public, max-age=300',
      'X-Robots-Tag': 'noindex',
    },
  });
}
app.get('/logo', (c) => serveLogo(c, 1));
app.get('/logo/:branchId', (c) => {
  const branchId = Number(c.req.param('branchId'));
  return Number.isInteger(branchId) && branchId > 0 ? serveLogo(c, branchId) : c.notFound();
});

// Admin: Cloudflare Access at the edge + JWT verification here (defense in depth).
app.use('/admin/*', accessMiddleware);
app.use('/admin/*', branchContext);

// PDF route lives here (not in admin.tsx) so it can share the renderer with /pay/:token/pdf.
app.get('/admin/invoices/:id/pdf', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();
  const invoice = await getInvoiceById(c.env.DB, id);
  if (!invoice) return c.notFound();
  const branchId = invoice.branch_id;
  const sourcePdf = await getInvoiceSourcePdf(c.env.DB, id);
  if (sourcePdf) return pdfResponse(sourcePdf.bytes, sourcePdf.filename);
  const [items, settings, logo] = await Promise.all([
    getInvoiceItems(c.env.DB, id),
    getSettings(c.env.DB, branchId),
    getLogo(c.env.DB, branchId),
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

app.get('/admin/invoices/:id/print', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();
  const invoice = await getInvoiceById(c.env.DB, id);
  if (!invoice) return c.notFound();
  const branchId = invoice.branch_id;
  const [items, settings, logo] = await Promise.all([
    getInvoiceItems(c.env.DB, id),
    getSettings(c.env.DB, branchId),
    getLogo(c.env.DB, branchId),
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

app.route('/admin', admin);

// Public invoice routes — deliberately outside the Access boundary.
app.route('/pay', pay);

app.notFound((c) => {
  c.header('X-Robots-Tag', 'noindex');
  return c.html(<NotFoundPage nonce={c.get('secureHeadersNonce')} />, 404);
});

// Unhandled errors: log, alert the business email (fire-and-forget), 500.
app.onError((err, c) => {
  const safePath = redactSensitivePath(c.req.path);
  console.error('unhandled error', safePath, err);
  c.executionCtx.waitUntil(sendErrorAlert(c.env, c.env.DB, err, safePath));
  return c.text('Something went wrong. The error has been reported.', 500);
});

export default {
  fetch: app.fetch,
  // Daily cron (wrangler.jsonc triggers): enqueue due reminders (opt-in via
  // Settings), drain the email outbox (delivers reminders + retries any
  // email notifications that failed their immediate attempt), then housekeeping.
  scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await sendOverdueReminders(env);
        await processEmailOutbox(env);
        await purgeOldOutbox(env.DB, MAX_OUTBOX_ATTEMPTS);
        await purgeOldLoginAttempts(env.DB);
      })()
    );
  },
};
