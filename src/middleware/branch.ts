import { getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { listBranches } from '../db/queries';

export const BRANCH_COOKIE = 'jj_invoice_branch';

export function selectBranch(c: Context<AppEnv>, branchId: number): void {
  setCookie(c, BRANCH_COOKIE, String(branchId), {
    path: '/admin',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** Resolve the active invoice branch from a tamperable preference cookie.
 *  The cookie is never trusted: only active branch IDs returned by D1 qualify. */
export const branchContext = createMiddleware<AppEnv>(async (c, next) => {
  const branches = await listBranches(c.env.DB);
  if (branches.length === 0) return c.text('No invoice branch is configured.', 503);

  const requested = Number(getCookie(c, BRANCH_COOKIE));
  const branch = branches.find((candidate) => candidate.id === requested) ?? branches[0];
  c.set('branchId', branch.id);
  c.set('branchName', branch.name);
  if (branch.id !== requested) selectBranch(c, branch.id);
  await next();
});

