import { getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { listBranches, listWorkspaces } from '../db/queries';

export const BRANCH_COOKIE = 'jj_invoice_branch';
export const WORKSPACE_COOKIE = 'jj_invoice_workspace';

export function selectWorkspace(c: Context<AppEnv>, workspaceId: number): void {
  setCookie(c, WORKSPACE_COOKIE, String(workspaceId), {
    path: '/admin',
    httpOnly: false,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 365,
  });
}

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
  const workspaces = await listWorkspaces(c.env.DB);
  if (workspaces.length === 0) return c.text('No workspace is configured.', 503);

  const queryWorkspace = Number(c.req.query('workspace'));
  const cookieWorkspace = Number(getCookie(c, WORKSPACE_COOKIE));
  const requestedWorkspace = Number.isInteger(queryWorkspace) && queryWorkspace > 0
    ? queryWorkspace
    : cookieWorkspace;
  const workspace = workspaces.find((candidate) => candidate.id === requestedWorkspace) ?? workspaces[0];
  c.set('workspaceId', workspace.id);
  c.set('workspaceName', workspace.name);
  if (workspace.id !== cookieWorkspace) selectWorkspace(c, workspace.id);

  const branches = await listBranches(c.env.DB, workspace.id);
  if (branches.length === 0) return c.text('No invoice branch is configured.', 503);

  const requested = Number(getCookie(c, BRANCH_COOKIE));
  const branch = branches.find((candidate) => candidate.id === requested) ?? branches[0];
  c.set('branchId', branch.id);
  c.set('branchName', branch.name);
  if (branch.id !== requested) selectBranch(c, branch.id);
  await next();
});

