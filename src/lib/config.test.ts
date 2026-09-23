import { describe, expect, it } from 'vitest';
import { configWarnings } from './config';
import { box } from './secretbox';
import type { Bindings } from '../env';
import type { Settings } from '../db/queries';

const fullEnv = {
  EMAIL: {},
  STRIPE_SECRET_KEY: 'sk',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  PAYPAL_CLIENT_ID: 'cid',
  PAYPAL_CLIENT_SECRET: 'csec',
  PAYPAL_WEBHOOK_ID: 'wh',
  RESEND_API_KEY: 're',
} as Bindings;

const base = {
  email_from: 'invoices@example.com',
  stripe_enabled: 1,
  paypal_enabled: 1,
  stripe_secret_key: '',
  stripe_webhook_secret: '',
  paypal_client_id: '',
  paypal_client_secret: '',
  paypal_webhook_id: '',
  resend_api_key: '',
};
const cf = { ...base, email_provider: 'cloudflare' } as Settings;
const resend = { ...base, email_provider: 'resend' } as Settings;

describe('configWarnings', () => {
  it('is silent when everything is set', async () => {
    expect(await configWarnings(fullEnv, cf)).toEqual([]);
  });

  it('does not warn about online payment providers because checkout is disabled', async () => {
    const env = {
      ...fullEnv,
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      PAYPAL_CLIENT_ID: '',
      PAYPAL_CLIENT_SECRET: '',
      PAYPAL_WEBHOOK_ID: '',
    } as Bindings;
    expect(await configWarnings(env, cf)).toEqual([]);
    expect(await configWarnings(env, { ...cf, stripe_enabled: 0, paypal_enabled: 0 })).toEqual([]);
  });

  it('flags cloudflare email provider without the send_email binding', async () => {
    const env = { ...fullEnv, EMAIL: undefined } as unknown as Bindings;
    expect((await configWarnings(env, cf)).some((m) => m.text.includes('send_email binding'))).toBe(true);
    expect(await configWarnings(env, resend)).toEqual([]);
  });

  it('nudges toward Access when running on password auth', async () => {
    const env = { ...fullEnv, ADMIN_PASSWORD: 'pw' } as Bindings;
    expect((await configWarnings(env, cf)).some((m) => m.text.includes('password-based'))).toBe(true);
    // access configured -> no nudge
    const accessEnv = {
      ...fullEnv,
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'a'.repeat(64),
      ADMIN_PASSWORD: 'pw',
    } as Bindings;
    expect(await configWarnings(accessEnv, cf)).toEqual([]);
  });

  it('flags a missing From address', async () => {
    const noFrom = { ...cf, email_from: '' } as Settings;
    expect((await configWarnings(fullEnv, noFrom)).some((m) => m.text.includes('From address'))).toBe(true);
  });

  it('only requires a Resend key when Resend is selected', async () => {
    const env = { ...fullEnv, RESEND_API_KEY: undefined } as Bindings;
    expect(await configWarnings(env, cf)).toEqual([]);
    expect((await configWarnings(env, resend)).some((m) => m.text.includes('Resend API key'))).toBe(true);
  });

  it('email provider "none" replaces config warnings with a single emails-off notice', async () => {
    const env = { ...fullEnv, RESEND_API_KEY: undefined, EMAIL: undefined } as unknown as Bindings;
    const none = { ...cf, email_provider: 'none', email_from: '' } as Settings;
    const w = await configWarnings(env, none);
    expect(w).toHaveLength(1);
    expect(w[0].text).toContain('Email sending is off');
  });

  it('settings-stored keys satisfy the checks (with an unencrypted advisory sans master key)', async () => {
    const env = { ...fullEnv, RESEND_API_KEY: '' } as Bindings;
    const stored = { ...cf, resend_api_key: 're_live_db' } as Settings;
    const w = await configWarnings(env, stored);
    expect(w).toHaveLength(1);
    expect(w[0].category).toBe('auth');
    expect(w[0].text).toContain('stored unencrypted');
  });

  it('a placeholder or short master key counts as absent and is called out', async () => {
    const env = { ...fullEnv, RESEND_API_KEY: '', SETTINGS_MASTER_KEY: 'change-me' } as Bindings;
    const stored = { ...cf, resend_api_key: 're_live_db' } as Settings;
    const w = await configWarnings(env, stored);
    expect(w).toHaveLength(1);
    expect(w[0].category).toBe('auth');
    expect(w[0].text).toContain('set but invalid');
  });

  it('boxed stored keys with the master key are silent', async () => {
    const env = { ...fullEnv, RESEND_API_KEY: '', SETTINGS_MASTER_KEY: 'unit-test-master-key-0123456789abcdef' } as Bindings;
    const stored = {
      ...cf,
      resend_api_key: await box('unit-test-master-key-0123456789abcdef', 're_live_db'),
    } as Settings;
    expect(await configWarnings(env, stored)).toEqual([]);
  });

  it('flags undecryptable stored keys loudly', async () => {
    const env = { ...fullEnv, RESEND_API_KEY: '', SETTINGS_MASTER_KEY: 'a-different-master-key-fedcba9876543210' } as Bindings;
    const stored = {
      ...cf,
      resend_api_key: await box('unit-test-master-key-0123456789abcdef', 're_live_db'),
    } as Settings;
    const w = await configWarnings(env, stored);
    expect(w.some((m) => m.category === 'email' && m.text.includes('cannot be decrypted'))).toBe(true);
  });
});

describe('configWarnings: Gmail payment matching', () => {
  const key = 'unit-test-master-key-0123456789abcdef';
  const gmailEnv = { ...fullEnv, GMAIL_CLIENT_ID: 'gid', GMAIL_CLIENT_SECRET: 'gsec', SETTINGS_MASTER_KEY: key } as Bindings;
  const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const gmail = async (overrides: Partial<Settings> = {}) =>
    ({
      ...cf,
      gmail_enabled: 1,
      gmail_address: 'books@example.test',
      gmail_refresh_token: await box(key, 'refresh-token'),
      gmail_query: 'from:payments@bank.example',
      gmail_last_checked_at: sqlTime(Date.now() - 30 * 60 * 1000),
      ...overrides,
    }) as Settings;
  const texts = async (env: Bindings, settings: Settings) => (await configWarnings(env, settings)).map((w) => w.text);

  it('is silent while connected and checking on schedule', async () => {
    expect(await configWarnings(gmailEnv, await gmail())).toEqual([]);
    // A fresh connection has not run yet; that is not a failure.
    expect(await configWarnings(gmailEnv, await gmail({ gmail_last_checked_at: null }))).toEqual([]);
  });

  it('stays silent while switched off', async () => {
    const off = await gmail({ gmail_enabled: 0, gmail_query: '', gmail_last_checked_at: '2026-01-01 00:00:00' });
    expect(await configWarnings(fullEnv, off)).toEqual([]);
  });

  it('flags checks that stopped completing', async () => {
    const stale = await gmail({ gmail_last_checked_at: sqlTime(Date.now() - 5 * 60 * 60 * 1000) });
    expect((await texts(gmailEnv, stale)).some((t) => t.includes('has not completed a check since'))).toBe(true);
  });

  it('flags a search without a trusted sender', async () => {
    const loose = await gmail({ gmail_query: '"payment received"' });
    expect((await texts(gmailEnv, loose)).some((t) => t.includes('trusted from:'))).toBe(true);
  });

  it('flags missing OAuth client secrets', async () => {
    expect((await texts({ ...gmailEnv, GMAIL_CLIENT_SECRET: '' }, await gmail())).some((t) => t.includes('GMAIL_CLIENT_ID'))).toBe(
      true
    );
  });

  it('flags a refresh token the master key cannot open', async () => {
    const foreign = await gmail({ gmail_refresh_token: await box('a-different-master-key-fedcba9876543210', 'refresh-token') });
    expect((await texts(gmailEnv, foreign)).some((t) => t.includes('cannot be decrypted'))).toBe(true);
  });
});
