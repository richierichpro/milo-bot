import { randomBytes } from "node:crypto";
import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import { esc } from "../cards/templates.js";
import { apply, BATCH_MAX, BATCH_QUIET_MS, enoughToPlan, understand, type Heard } from "./listen.js";
import { loadState, resetState, saveState, type ChatState } from "./state.js";
import { tripCardKeyboard, tripCardText } from "./tripcard.js";

// Group chat behaviour: intro, listening, squad adds with Undo, the Trip card,
// pause/resume. Planning itself is plugged in through `hooks` by later steps.

export type Hooks = {
  /** Someone asked Milo to plan (button or words). */
  onPlanNow: (chatId: number) => Promise<void>;
  /** Callback buttons owned by later steps (votes, Heard card…). Return true when handled. */
  onCallback: (ctx: Context, state: ChatState) => Promise<boolean>;
  /** A reply or mention asking for a change, once a plan exists. */
  onEditRequest: (chatId: number, text: string) => Promise<void>;
};

const GAP_MS = Number(process.env.MESSAGE_GAP_MS ?? 400);
const today = () => process.env.MILO_TODAY ?? new Date().toISOString().slice(0, 10);

export class Milo {
  readonly hooks: Hooks = {
    onPlanNow: async (chatId) => {
      await this.say(chatId, "On it! 🗺 I'll check what I heard with you first.");
    },
    onCallback: async () => false,
    onEditRequest: async () => {},
  };

  private buffers = new Map<number, { msgs: Heard[]; timer?: ReturnType<typeof setTimeout> }>();
  private queues = new Map<number, Promise<unknown>>();

  constructor(readonly bot: Bot, readonly opts: { quietMs?: number; maxBatch?: number } = {}) {
    this.register();
  }

  // ---------- Sending ----------

  /** Messages to a chat go out one at a time, ~400 ms apart. */
  send<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const r = await fn();
      if (GAP_MS) await new Promise((res) => setTimeout(res, GAP_MS));
      return r;
    });
    this.queues.set(chatId, next);
    return next;
  }

  say(chatId: number, html: string, keyboard?: InlineKeyboard) {
    return this.send(chatId, () => this.bot.api.sendMessage(chatId, html, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } }));
  }

  /** Create or edit the pinned Trip card. If Milo can't pin, it just keeps the message. */
  async updateTripCard(state: ChatState) {
    const text = tripCardText(state);
    const kb = tripCardKeyboard(state, enoughToPlan(state));
    const card = state.tripCard;
    if (card) {
      try {
        await this.send(state.chatId, () => this.bot.api.editMessageText(state.chatId, card.messageId, text, { parse_mode: "HTML", reply_markup: kb }));
        return;
      } catch (err) {
        if (err instanceof GrammyError && /not modified/i.test(err.description)) return;
        // Deleted or too old: post a fresh one below.
      }
    }
    const msg = await this.say(state.chatId, text, kb);
    state.tripCard = { messageId: msg.message_id, pinned: false };
    try {
      await this.send(state.chatId, () => this.bot.api.pinChatMessage(state.chatId, msg.message_id, { disable_notification: true }));
      state.tripCard.pinned = true;
    } catch {
      // No pin rights: skip pinning.
    }
    await saveState(state);
  }

  // ---------- Handlers ----------

  private register() {
    const bot = this.bot;

    bot.on("my_chat_member", async (ctx) => {
      const { old_chat_member: before, new_chat_member: now, chat } = ctx.myChatMember;
      const joined = ["member", "administrator"].includes(now.status) && ["left", "kicked"].includes(before.status);
      if (!joined || (chat.type !== "group" && chat.type !== "supergroup")) return;
      await this.intro(chat.id);
    });

    // Hidden shortcuts for testing only: never listed or mentioned to users.
    bot.command("milo_reset", async (ctx) => {
      await saveState(resetState(ctx.chat.id));
      await this.intro(ctx.chat.id);
    });
    bot.command("milo_state", async (ctx) => {
      const s = await loadState(ctx.chat.id);
      await this.say(ctx.chat.id, `<pre>${esc(JSON.stringify({ stage: s.stage, listening: s.listening, squad: s.squad, trip: s.trip, mentioned: s.mentioned }, null, 1)).slice(0, 3900)}</pre>`);
    });
    bot.command("milo_flush", (ctx) => this.flush(ctx.chat.id));

    bot.on("callback_query:data", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return ctx.answerCallbackQuery();
      const state = await loadState(chatId);
      const data = ctx.callbackQuery.data;
      if (data === "plan_trip") {
        await ctx.answerCallbackQuery();
        return this.startListening(state);
      }
      if (data === "plan_now") {
        await ctx.answerCallbackQuery({ text: "Planning! 🗺" });
        return this.planNow(state);
      }
      if (data === "pause" || data === "resume") {
        state.paused = data === "pause";
        await saveState(state);
        await ctx.answerCallbackQuery({ text: state.paused ? "Milo is paused" : "Milo is back" });
        await this.say(chatId, state.paused ? "⏸ Paused. I won't read the chat until someone taps <b>Resume Milo</b> on the Trip card." : "▶️ Back! I'm listening again.");
        return this.updateTripCard(state);
      }
      if (data.startsWith("undo:")) return this.undo(ctx, state, data.slice(5));
      if (!(await this.hooks.onCallback(ctx, state))) await ctx.answerCallbackQuery();
    });

    bot.on("message:text", async (ctx) => {
      if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;
      if (ctx.message.text.startsWith("/")) return;
      const state = await loadState(ctx.chat.id);
      if (state.paused) return;
      const from = ctx.from;
      const heard: Heard = { messageId: ctx.message.message_id, userId: from.id, name: from.first_name, text: ctx.message.text };
      const toMilo = ctx.message.reply_to_message?.from?.id === bot.botInfo.id || new RegExp(`@${bot.botInfo.username}\\b`, "i").test(heard.text);
      if (state.stage === "done" && toMilo) return this.hooks.onEditRequest(state.chatId, heard.text);
      if (!state.listening) return;
      this.buffer(state.chatId, heard);
    });
  }

  async intro(chatId: number) {
    const state = await loadState(chatId);
    state.stage = "intro";
    state.listening = false;
    await saveState(state);
    await this.say(
      chatId,
      "👋 Hi, I'm <b>Milo</b>. I plan your squad's trip right here in the chat.\n\nTap the button and just talk like you normally do: who's in, where from, dates, budgets, food needs. I'll keep track, check everyone's limits, and come back with a plan that works for all of you.",
      new InlineKeyboard().text("Plan a trip ✈️", "plan_trip"),
    );
    if (!this.bot.botInfo.can_read_all_group_messages) {
      await this.say(
        chatId,
        "One thing first: I can't see your messages yet. 🙈\n\nEither make me an <b>admin</b> of this group, or open @BotFather → <code>/setprivacy</code> → pick me → <b>Disable</b>, then remove and re-add me.",
      );
    }
  }

  private async startListening(state: ChatState) {
    state.listening = true;
    state.stage = "listening";
    await saveState(state);
    await this.say(
      state.chatId,
      "👂 <b>I'm listening.</b> Chat as usual: who's coming and from where, your dates, budgets, food needs, must-dos.\n\nI'll stay quiet and react 👀 when I note something. Say <b>“Milo, plan it”</b> when you're ready.",
    );
    await this.updateTripCard(state);
  }

  private async planNow(state: ChatState) {
    if (state.stage !== "listening" && state.stage !== "intro") return;
    await this.flush(state.chatId);
    state.listening = false;
    await saveState(state);
    await this.hooks.onPlanNow(state.chatId);
  }

  private async undo(ctx: Context, state: ChatState, token: string) {
    const entry = state.undo[token];
    const who = String(ctx.from?.id);
    if (!entry) return ctx.answerCallbackQuery({ text: "Already done." });
    if (who !== entry.addedBy && who !== entry.memberId) {
      const name = state.squad.find((p) => p.id === entry.memberId)?.name ?? "them";
      return ctx.answerCallbackQuery({ text: `Only whoever added ${name} can undo this`, show_alert: true });
    }
    const removed = state.squad.find((p) => p.id === entry.memberId);
    state.squad = state.squad.filter((p) => p.id !== entry.memberId);
    delete state.undo[token];
    await saveState(state);
    await ctx.answerCallbackQuery({ text: `Removed ${removed?.name ?? ""}` });
    await ctx.editMessageText(`↩️ Took <b>${esc(removed?.name ?? "them")}</b> off the squad.`, { parse_mode: "HTML" });
    await this.updateTripCard(state);
  }

  // ---------- Listening ----------

  private buffer(chatId: number, m: Heard) {
    const b = this.buffers.get(chatId) ?? { msgs: [] };
    b.msgs.push(m);
    clearTimeout(b.timer);
    this.buffers.set(chatId, b);
    if (b.msgs.length >= (this.opts.maxBatch ?? BATCH_MAX)) void this.flush(chatId);
    else b.timer = setTimeout(() => void this.flush(chatId), this.opts.quietMs ?? BATCH_QUIET_MS);
  }

  /** Read everything buffered for a chat in one fast-model call. */
  async flush(chatId: number) {
    const b = this.buffers.get(chatId);
    if (!b?.msgs.length) return;
    clearTimeout(b.timer);
    const msgs = b.msgs.splice(0);
    const state = await loadState(chatId);
    let applied;
    try {
      applied = apply(state, await understand(msgs, state, today()), msgs);
    } catch (err) {
      console.error(`listen failed in ${chatId}:`, (err as Error).message);
      return;
    }
    await saveState(state);

    for (const id of applied.sourceIds) {
      await this.send(chatId, () => this.bot.api.setMessageReaction(chatId, id, [{ type: "emoji", emoji: "👀" }])).catch(() => {});
    }
    for (const { member, by } of applied.addedByOthers) {
      const token = randomBytes(4).toString("hex");
      state.undo[token] = { memberId: member.id, addedBy: member.proxyFor ?? "" };
      await this.say(chatId, `➕ Added <b>${esc(member.name)}</b>${member.city ? ` (${esc(member.city)})` : ""} to the squad, via ${esc(by)}.`, new InlineKeyboard().text("Undo", `undo:${token}`));
    }
    await saveState(state);
    await this.updateTripCard(state);

    if (applied.intents.some((i) => i.kind === "plan_now")) return this.planNow(state);
    if (applied.intents.some((i) => i.kind === "pause")) {
      state.paused = true;
      await saveState(state);
      return this.say(chatId, "⏸ Paused. Tap <b>Resume Milo</b> on the Trip card when you want me back.");
    }
    if (enoughToPlan(state) && !state.planItNowSent) {
      state.planItNowSent = true;
      await saveState(state);
      await this.say(chatId, "I think I've got enough to start. Plan whenever you're ready 👇", new InlineKeyboard().text("Plan it now 🗺", "plan_now"));
    }
  }

  async flushAll() {
    await Promise.all([...this.buffers.keys()].map((id) => this.flush(id)));
  }
}
