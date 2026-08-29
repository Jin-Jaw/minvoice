import type { Bindings } from '../env';
import type { Settings } from '../db/queries';
import { authMode } from './admin-auth';
import { effectiveProviderEnv, storedSecretsHealth } from './providers';
import { validMasterKey } from './secretbox';

// Example/template values that have historically leaked into real secrets
// (one-click deploys prompt from .dev.vars.example) — never treat as configured.
const PLACEHOLDER_VALUES = new Set([
  'sk_test_xxx',
  'whsec_xxx',
  'sandbox_client_id',
  'sandbox_client_secret',
  'sandbox_webhook_id',
  'change-me',
]);

/** A secret counts as configured only when set AND not a known placeholder. */
export function secretConfigured(v: string | undefined): boolean {
  const t = (v ?? '').trim();
  return t !== '' && !PLACEHOLDER_VALUES.has(t);
}

export type ConfigWarning = { text: string; category: 'email' | 'auth' };

/**
 * Human-readable warnings for missing configuration. Client-affecting
 * Email warnings surface on the dashboard so misconfiguration
 * is seen before a client hits it; ALL categories (including the softer
 * auth advice) show in Settings -> Alerts.
 */
export async function configWarnings(
  env: Bindings,
  settings: Settings,
): Promise<ConfigWarning[]> {
  const warnings: ConfigWarning[] = [];
  const e = await effectiveProviderEnv(env, settings);
  const push = (category: ConfigWarning['category'], text: string) => warnings.push({ category, text });

  const secrets = await storedSecretsHealth(env, settings, ['resend_api_key']);
  if (secrets.undecryptable) {
    push('email', 'The stored email API key cannot be decrypted — SETTINGS_MASTER_KEY is missing, changed, or invalid. Restore the original secret, or re-enter the key in Settings.');
  } else if (secrets.plaintextStored && !validMasterKey(env.SETTINGS_MASTER_KEY)) {
    push(
      'auth',
      (env.SETTINGS_MASTER_KEY ?? '').trim()
        ? 'SETTINGS_MASTER_KEY is set but invalid (a known placeholder, or under 32 characters) — the email API key entered in Settings stays unencrypted until it is replaced with a strong value.'
        : 'The email API key entered in Settings is stored unencrypted — set a SETTINGS_MASTER_KEY secret (`npm run deploy` generates one) to encrypt it at rest.'
    );
  }
  if (settings.email_provider === 'none') {
    push('email', 'Email sending is off (Settings → Email) — no invoice emails, receipts, or error alerts will be sent.');
  }
  if (settings.email_provider !== 'none') {
    if (settings.email_provider === 'resend' && !e.RESEND_API_KEY) {
      push('email', 'Email provider is Resend but no Resend API key is configured — all emails will fail.');
    }
    if (settings.email_provider === 'cloudflare' && !env.EMAIL) {
      push('email', 'Email provider is Cloudflare but the send_email binding is not configured — switch to Resend in Settings or add the binding.');
    }
    if (!settings.email_from.trim()) {
      push('email', 'No email From address set (Settings) — invoice and receipt emails will fail.');
    }
  }
  if (authMode(env) === 'password') {
    push('auth', 'Admin login is password-based — configure Cloudflare Access for stronger auth (it takes over automatically).');
  }
  return warnings;
}
