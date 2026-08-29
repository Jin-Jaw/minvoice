#!/usr/bin/env node
// Export the complete production D1 database to a timestamped, gitignored SQL
// snapshot. D1 Time Travel is useful for recent recovery; these exports are
// the long-retention copy controlled by Jin&Jaw.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
const backupDir = resolve('backups');
const output = resolve(backupDir, `jinjaw-invoices-${stamp}.sql`);
const wrangler = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');

mkdirSync(backupDir, { recursive: true });
execFileSync(process.execPath, [
  wrangler,
  'd1',
  'export',
  'DB',
  '--remote',
  '--output',
  output,
], { stdio: 'inherit' });

console.log(`Invoice backup written to ${output}`);
