import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { Milo } from "./conversation.js";

export const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"] as const;
export const DESCRIPTION = "I plan your squad's trip right here in the chat.";

/** Builds the bot. The simulator passes botInfo and a fake transport so nothing reaches Telegram. */
export function createMilo(token: string, opts: { botInfo?: UserFromGetMe; quietMs?: number } = {}) {
  const bot = new Bot(token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
  bot.api.config.use(autoRetry());
  const milo = new Milo(bot, { quietMs: opts.quietMs });
  bot.catch((err) => console.error("bot error:", err.error instanceof Error ? err.error.message : err.error));
  return { bot, milo };
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in .env.local");
  const { bot } = createMilo(token);
  await bot.init();
  await bot.api.setMyDescription(DESCRIPTION).catch(() => {});
  await bot.api.setMyShortDescription(DESCRIPTION).catch(() => {});
  // Slash commands stay hidden: clear any menu.
  await bot.api.deleteMyCommands().catch(() => {});
  console.log(`Milo is running as @${bot.botInfo.username} (can read group messages: ${bot.botInfo.can_read_all_group_messages})`);
  await bot.start({ allowed_updates: [...ALLOWED_UPDATES], drop_pending_updates: true });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
