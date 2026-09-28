// Replies both bots send for every update, before and after handling it.

import type { TelegramApi } from './api';
import type { TelegramUpdate } from './handler';

/**
 * Starts the replies that don't depend on the update's outcome: answering a
 * button tap stops its spinner, and "typing…" shows the bot is working.
 * Telegram only accepts an answer for a short time, so a late or failed one
 * is ignored rather than stopping the action. Await the result before the
 * handler returns, or the Worker may cancel the requests.
 */
export function acknowledgeUpdate(api: TelegramApi, update: TelegramUpdate, chatId: string): Promise<unknown> {
  return Promise.allSettled([
    update.callback_query ? api.answerCallbackQuery(update.callback_query.id) : undefined,
    api.sendChatAction(chatId, 'typing'),
  ]);
}

/** One log line per update, so slow replies show up in the Worker logs. */
export function logUpdateTiming(bot: 'admin' | 'submissions', update: TelegramUpdate, startedAt: number): void {
  const type = update.callback_query ? 'button' : update.message?.text?.startsWith('/') ? 'command' : 'message';
  console.log(JSON.stringify({ event: 'telegram_update_handled', bot, type, ms: Date.now() - startedAt }));
}
