/**
 * Expense evidence the admin pages preview in the evidence viewer. PDFs show
 * in a same-origin frame, so these responses are the only ones that relax
 * frame-ancestors and X-Frame-Options from 'none'/DENY to same-origin.
 */
const FRAMEABLE_EVIDENCE_PATHS = [
  /^\/admin\/expenses\/\d+\/attachments\/\d+\/view$/,
  /^\/admin\/expenses\/import\/[a-f0-9]{64}\/file$/,
];

export function isFrameableEvidencePath(path: string): boolean {
  return FRAMEABLE_EVIDENCE_PATHS.some((pattern) => pattern.test(path));
}

/** Content-Disposition for an evidence file, keeping non-ASCII names intact. */
export function evidenceDisposition(type: 'inline' | 'attachment', filename: string): string {
  const asciiName = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encodedName = encodeURIComponent(filename).replace(/'/g, '%27');
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}
