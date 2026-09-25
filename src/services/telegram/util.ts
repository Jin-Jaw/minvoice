// Helpers shared by the admin bot and the submissions bot: evidence files,
// HTML escaping and user-facing error text.

import { MAX_EXPENSE_ATTACHMENT_BYTES } from '../../lib/expenses';
import type { TelegramMessage } from './api';

export const IMAGE_MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

export type SniffedMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

/** The expense evidence to download: a PDF/image document, or the largest photo size under the limit. */
export function evidenceSource(message: TelegramMessage): { fileId: string; declaredMime: string; size?: number; name?: string } {
  const document = message.document;
  if (document) {
    const mime = document.mime_type ?? '';
    if (mime !== 'application/pdf' && !IMAGE_MIMES.includes(mime)) {
      throw new Error('Send the supplier invoice as a PDF, or a JPG, PNG or WebP photo of the receipt.');
    }
    return { fileId: document.file_id, declaredMime: mime, size: document.file_size, name: document.file_name };
  }
  const sizes = message.photo ?? [];
  const photo = [...sizes].reverse().find((size) => (size.file_size ?? 0) <= MAX_EXPENSE_ATTACHMENT_BYTES) ?? sizes[0];
  if (!photo) throw new Error('No file was found in that message.');
  return { fileId: photo.file_id, declaredMime: 'image/jpeg', size: photo.file_size };
}

export function sniffMime(bytes: Uint8Array): SniffedMime | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }
  if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-') return 'application/pdf';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function sanitizeFilename(name: string, mime: SniffedMime): string {
  const extension =
    mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  const stem =
    name
      .replace(/\.[^.]*$/, '')
      .normalize('NFKC')
      .replace(/[^a-zA-Z0-9._ -]/g, '_')
      .replace(/\.{2,}/g, '.')
      .trim()
      .slice(0, 100) || 'attachment';
  return `${stem}${extension}`;
}

export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function humanError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  if (/constraint|SQLITE|D1_/i.test(message)) return 'I couldn’t save that safely. Please try again or use the invoicing app.';
  return message.slice(0, 300);
}
