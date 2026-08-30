import type { ExpenseAttachment } from '../db/queries';

export const EXPENSE_CATEGORIES = [
  'Employees & contractors',
  'Software & services',
  'Travel & accommodation',
  'Professional fees',
  'Marketing',
  'Equipment & supplies',
  'Banking & finance',
  'Taxes & government fees',
  'Other',
] as const;

/** D1 rows are capped at 2 MB. Leave room for metadata and serialization. */
export const MAX_EXPENSE_ATTACHMENT_BYTES = 1536 * 1024;

type EvidenceFile = Pick<ExpenseAttachment, 'bytes' | 'mime' | 'filename' | 'size_bytes' | 'sha256'>;

function detectedMime(bytes: Uint8Array): ExpenseAttachment['mime'] | null {
  if (bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return null;
}

function safeFilename(name: string, mime: ExpenseAttachment['mime']): string {
  const extension = mime === 'application/pdf' ? '.pdf' : mime === 'image/jpeg' ? '.jpg' : mime === 'image/png' ? '.png' : '.webp';
  let cleaned = name.split(/[\\/]/).pop()?.normalize('NFKC') ?? '';
  cleaned = cleaned.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_').trim().slice(0, 180);
  if (!cleaned) return `evidence${extension}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(cleaned)) cleaned += extension;
  return cleaned;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verify bytes, not the browser-provided MIME type. SVG/HTML are deliberately
 * rejected, and downloads are still forced as attachments by the route. */
export async function prepareExpenseAttachment(file: File): Promise<{ file?: EvidenceFile; error?: string }> {
  if (file.size === 0) return { error: 'Choose a non-empty evidence file.' };
  if (file.size > MAX_EXPENSE_ATTACHMENT_BYTES) return { error: 'Evidence files must be 1.5 MB or smaller.' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = detectedMime(bytes);
  if (!mime) return { error: 'Evidence must be a genuine PDF, JPG, PNG, or WebP file.' };
  return {
    file: {
      bytes,
      mime,
      filename: safeFilename(file.name, mime),
      size_bytes: bytes.byteLength,
      sha256: hex(await crypto.subtle.digest('SHA-256', bytes)),
    },
  };
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
