import type { Bot, RawApi, Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";

// A fake Telegram for the simulator and tests: every API call is recorded and
// answered locally, and updates are fed straight into the bot's handlers.

export const FAKE_BOT: UserFromGetMe = {
  id: 999_000,
  is_bot: true,
  first_name: "Milo",
  username: "MiloTripPlannerBot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export type Sent = { method: string; payload: Record<string, unknown>; messageId?: number };

export class FakeTelegram {
  readonly sent: Sent[] = [];
  private nextMessageId = 100;
  private nextUpdateId = 1;
  constructor(readonly chatId = -1001, readonly title = "Goa trip 🌴") {}

  /** Plug into bot.api.config.use(). */
  transformer(): Transformer<RawApi> {
    return async (_prev, method, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const chat = { id: this.chatId, type: "supergroup" as const, title: this.title };
      const msg = (extra: Record<string, unknown> = {}) => ({ message_id: ++this.nextMessageId, date: Math.floor(Date.now() / 1000), chat, ...extra });
      let result: unknown = true;
      let messageId: number | undefined;
      switch (method) {
        case "sendMessage":
        case "sendPhoto":
        case "sendDocument": {
          const m = msg({ text: p.text, caption: p.caption, from: FAKE_BOT });
          messageId = m.message_id;
          result = m;
          break;
        }
        case "sendMediaGroup": {
          const media = (p.media as unknown[]) ?? [];
          const ms = media.map(() => msg({ from: FAKE_BOT }));
          messageId = ms[0]?.message_id;
          result = ms;
          break;
        }
        case "editMessageText":
        case "editMessageCaption":
        case "editMessageMedia":
        case "editMessageReplyMarkup":
          result = msg({ text: p.text });
          break;
        case "getMe":
          result = FAKE_BOT;
          break;
      }
      this.sent.push({ method, payload: p, messageId });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: true, result } as any;
    };
  }

  private user(id: number, name: string) {
    return { id, is_bot: false, first_name: name };
  }

  /** Someone adds Milo to the group. */
  async addBot(bot: Bot, by: { id: number; name: string }) {
    await bot.handleUpdate({
      update_id: this.nextUpdateId++,
      my_chat_member: {
        chat: { id: this.chatId, type: "supergroup", title: this.title },
        from: this.user(by.id, by.name),
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: "left", user: FAKE_BOT },
        new_chat_member: { status: "member", user: FAKE_BOT },
      },
    } as Update);
  }

  /** A group message; returns its id. */
  async say(bot: Bot, from: { id: number; name: string }, text: string, replyTo?: number): Promise<number> {
    const message_id = ++this.nextMessageId;
    await bot.handleUpdate({
      update_id: this.nextUpdateId++,
      message: {
        message_id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: this.chatId, type: "supergroup", title: this.title },
        from: this.user(from.id, from.name),
        text,
        ...(replyTo ? { reply_to_message: { message_id: replyTo, date: 0, chat: { id: this.chatId, type: "supergroup", title: this.title }, from: FAKE_BOT, text: "" } } : {}),
      },
    } as Update);
    return message_id;
  }

  /** Someone taps an inline button on a message Milo sent. */
  async tap(bot: Bot, from: { id: number; name: string }, data: string, messageId?: number) {
    await bot.handleUpdate({
      update_id: this.nextUpdateId++,
      callback_query: {
        id: String(this.nextUpdateId),
        from: this.user(from.id, from.name),
        chat_instance: "sim",
        data,
        message: { message_id: messageId ?? this.lastWithButton(data) ?? 0, date: 0, chat: { id: this.chatId, type: "supergroup", title: this.title }, from: FAKE_BOT, text: "" },
      },
    } as Update);
  }

  /** The latest message Milo sent that has a button with this callback data. */
  lastWithButton(data: string): number | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const kb = (this.sent[i].payload.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard;
      if (kb?.some((row) => row.some((b) => b.callback_data === data))) return this.sent[i].messageId ?? (this.sent[i].payload.message_id as number);
    }
    return undefined;
  }

  /** Callback answers (pop-ups) shown to the tapper. */
  popups(): string[] {
    return this.sent.filter((s) => s.method === "answerCallbackQuery" && s.payload.text).map((s) => String(s.payload.text));
  }
}
