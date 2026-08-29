import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBranch, getLogo, setLogo } from '../src/db/queries';

const DB = env.DB;

// Minimal valid 1x1 PNG.
const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0)
);

beforeEach(async () => {
  await DB.prepare('DELETE FROM branch_logos').run();
});

describe('uploaded logo', () => {
  it('round-trips bytes and mime through D1', async () => {
    await setLogo(DB, PNG_1X1, 'image/png');
    const logo = await getLogo(DB);
    expect(logo?.mime).toBe('image/png');
    expect(logo?.bytes.length).toBe(PNG_1X1.length);
    expect([...logo!.bytes.slice(0, 4)]).toEqual([...PNG_1X1.slice(0, 4)]); // PNG magic
  });

  it('replaces the previous logo on re-upload', async () => {
    await setLogo(DB, PNG_1X1, 'image/png');
    await setLogo(DB, PNG_1X1.slice(0, 20), 'image/jpeg');
    const logo = await getLogo(DB);
    expect(logo?.mime).toBe('image/jpeg');
    expect(logo?.bytes.length).toBe(20);
  });

  it('keeps uploaded logos separate for each branch', async () => {
    const branchId = await createBranch(DB, {
      name: 'Logo Branch',
      business_address: '2 Branch Street',
      business_email: null,
      currency: 'GBP',
      invoice_prefix: 'LOGO-',
    });
    await setLogo(DB, 1, PNG_1X1, 'image/png');
    await setLogo(DB, branchId, PNG_1X1.slice(0, 20), 'image/jpeg');
    expect((await getLogo(DB, 1))?.mime).toBe('image/png');
    expect((await getLogo(DB, branchId))?.mime).toBe('image/jpeg');
  });

  it('serves /logo publicly with the right headers, 404 when absent', async () => {
    expect((await exports.default.fetch(new Request('https://invoice.test/logo'))).status).toBe(404);

    await setLogo(DB, PNG_1X1, 'image/png');
    const res = await exports.default.fetch(new Request('https://invoice.test/logo'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(PNG_1X1.length);
  });
});
