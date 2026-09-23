// Minimal Telegram Bot API client (only the methods the bot uses).

import type { Bindings } from '../../env';

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type InlineKeyboard = InlineButton[][];

export type TelegramUser = { id: number; username?: string };
export type TelegramChat = { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
export type TelegramDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};
export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};
export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  /** Every size Telegram generated, smallest first. */
  photo?: TelegramPhotoSize[];
};
export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

type TelegramFile = { file_id: string; file_size?: number; file_path?: string };

function limitLabel(maxBytes: number): string {
  const mb = maxBytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export class TelegramApi {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, body: unknown): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!response.ok || !result.ok || result.result === undefined) {
      throw new Error(`Telegram ${method} failed: ${result.description ?? response.status}`);
    }
    return result.result;
  }

  sendMessage(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<TelegramMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  editMessage(chatId: string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<TelegramMessage> {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  answerCallbackQuery(id: string, text?: string): Promise<boolean> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }

  /** "typing…" / "uploading…" indicator while slow work (OCR, PDFs) runs. */
  sendChatAction(chatId: string, action: 'typing' | 'upload_document'): Promise<boolean> {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  getFile(fileId: string): Promise<TelegramFile> {
    return this.call('getFile', { file_id: fileId });
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
    const tooLarge = `That file is larger than the ${limitLabel(maxBytes)} limit.`;
    const file = await this.getFile(fileId);
    if (file.file_size && file.file_size > maxBytes) throw new Error(tooLarge);
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new Error('Telegram could not provide that file. Please try again.');
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error(tooLarge);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(tooLarge);
    return bytes;
  }

  async sendDocument(chatId: string, bytes: Uint8Array, filename: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('document', new File([bytes], filename, { type: 'application/pdf' }));
    if (caption) form.set('caption', caption);
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, { method: 'POST', body: form });
    const result = (await response.json()) as { ok: boolean; description?: string };
    if (!response.ok || !result.ok) throw new Error(`Telegram sendDocument failed: ${result.description ?? response.status}`);
  }
}

export function telegramApi(env: Bindings): TelegramApi | null {
  return env.TELEGRAM_BOT_TOKEN ? new TelegramApi(env.TELEGRAM_BOT_TOKEN) : null;
}
