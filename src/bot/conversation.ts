import { randomBytes } from "node:crypto";
import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import { esc } from "../cards/templates.js";
import { apply, BATCH_MAX, BATCH_QUIET_MS, enoughToPlan, understand, type Heard } from "./listen.js";
import { loadState, resetState, saveState, type ChatState } from "./state.js";
import { chipLabel } from "./render.js";
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
  /** Typed answers the planning flow is waiting for (fixes, "Other"). Return true when handled. */
  onMessage: (state: ChatState, heard: Heard) => Promise<boolean>;
};

const GAP_MS = Number(process.env.MESSAGE_GAP_MS ?? 400);
/** While Milo is asking step-by-step questions, reply after 5 s of quiet instead of 15. */
const SETUP_QUIET_MS = 5_000;

/** "this_weekend" / "next_weekend" → Friday–Sunday. */
export function weekendRange(value: string, from = process.env.MILO_TODAY ?? new Date().toISOString().slice(0, 10)): [string, string] | undefined {
  if (value !== "this_weekend" && value !== "next_weekend") return undefined;
  const d = new Date(`${from}T00:00:00Z`);
  const toFri = ((5 - d.getUTCDay() + 7) % 7) + (value === "next_weekend" ? 7 : 0);
  const fri = new Date(d.getTime() + toFri * 86_400_000);
  return [fri.toISOString().slice(0, 10), new Date(fri.getTime() + 2 * 86_400_000).toISOString().slice(0, 10)];
}
const today = () => process.env.MILO_TODAY ?? new Date().toISOString().slice(0, 10);

export class Milo {
  readonly hooks: Hooks = {
    onPlanNow: async (chatId) => {
      await this.say(chatId, "On it! 🗺 I'll check what I heard with you first.");
    },
    onCallback: async () => false,
    onEditRequest: async () => {},
    onMessage: async () => false,
  };

  /** Chats this process has seen, for the vote clock. */
  readonly knownChats = new Set<number>();

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
      this.knownChats.add(chatId);
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
      if (data.startsWith("setup:")) return this.onSetup(ctx, state, data.slice(6));
      if (!(await this.hooks.onCallback(ctx, state))) await ctx.answerCallbackQuery();
    });

    bot.on("message:text", async (ctx) => {
      if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;
      if (ctx.message.text.startsWith("/")) return;
      const state = await loadState(ctx.chat.id);
      if (state.paused) return;
      const from = ctx.from;
      const heard: Heard = { messageId: ctx.message.message_id, userId: from.id, name: from.first_name, text: ctx.message.text };
      this.knownChats.add(state.chatId);
      if (await this.hooks.onMessage(state, heard)) return;
      const toMilo = ctx.message.reply_to_message?.from?.id === bot.botInfo.id || new RegExp(`@${bot.botInfo.username}\\b`, "i").test(heard.text);
      if (state.stage === "done" && toMilo) return this.hooks.onEditRequest(state.chatId, heard.text);
      if (!state.listening) return;
      this.buffer(state.chatId, heard, state.data.setup ? SETUP_QUIET_MS : undefined);
    });
  }

  async intro(chatId: number) {
    const state = await loadState(chatId);
    state.stage = "intro";
    state.listening = false;
    await saveState(state);
    await this.say(
      chatId,
      "Hey! I'm <b>Milo</b> 👋\nI'll plan your trip right here in the chat.",
      new InlineKeyboard().text("Plan a trip ✈️", "plan_trip"),
    );
    if (!this.bot.botInfo.can_read_all_group_messages) {
      await this.say(
        chatId,
        "Quick thing: I can't see your messages yet 🙈\nMake me an <b>admin</b>, or in @BotFather: <code>/setprivacy</code> → <b>Disable</b>, then re-add me.",
      );
    }
  }

  private async startListening(state: ChatState) {
    state.listening = true;
    state.stage = "listening";
    state.data.setup = "who";
    await saveState(state);
    await this.updateTripCard(state);
    await this.typing(state.chatId);
    await this.say(state.chatId, "Let's go! 🙌\n<b>Who's in?</b> Tell me where you're flying from.", new InlineKeyboard().text("That's everyone ✅", "setup:next"));
  }

  // ---------- Step by step: who → where → when → anything else ----------

  private typing(chatId: number) {
    return this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }

  private async askWhere(state: ChatState) {
    state.data.setup = "where";
    await saveState(state);
    await this.typing(state.chatId);
    const named = state.mentioned[0];
    if (named)
      return void (await this.say(state.chatId, `📍 <b>${esc(named)}</b>, yeah?`, new InlineKeyboard().text(`Yes, ${named} ✅`, "setup:dest").text("Show me options 💡", "setup:suggest")));
    await this.say(state.chatId, "📍 <b>Where do you wanna go?</b>", new InlineKeyboard().text("Suggest places 💡", "setup:suggest"));
  }

  private async askWhen(state: ChatState) {
    if (state.trip.startDate && state.trip.endDate) return this.askExtras(state);
    state.data.setup = "when";
    await saveState(state);
    await this.typing(state.chatId);
    await this.say(
      state.chatId,
      "📅 <b>When?</b>",
      new InlineKeyboard().text("This weekend", "setup:when:this_weekend").text("Next weekend", "setup:when:next_weekend").row().text("Pick dates ✍️", "setup:when:other"),
    );
  }

  private async askExtras(state: ChatState) {
    state.data.setup = "extras";
    state.planItNowSent = true;
    await saveState(state);
    await this.updateTripCard(state);
    await this.typing(state.chatId);
    await this.say(state.chatId, "Anything else? 💸 budgets, 🍽 food, 📌 must-dos…\nOr I'll start 👇", new InlineKeyboard().text("Plan it now 🗺", "plan_now"));
  }

  private async onSetup(ctx: Context, state: ChatState, action: string) {
    const step = state.data.setup;
    if (action === "next") {
      if (step !== "who") return ctx.answerCallbackQuery();
      if (!state.squad.length) return ctx.answerCallbackQuery({ text: "Say “I'm in” first 🙂", show_alert: true });
      await ctx.answerCallbackQuery();
      await this.flush(state.chatId);
      return this.askWhere(state);
    }
    if (action === "dest" || action === "suggest") {
      if (step !== "where") return ctx.answerCallbackQuery();
      await ctx.answerCallbackQuery();
      if (action === "dest" && state.mentioned[0]) {
        state.trip.destination = state.mentioned[0];
        if (!state.decisions.includes(`Going to ${state.trip.destination}`)) state.decisions.push(`Going to ${state.trip.destination}`);
      } else await this.say(state.chatId, "Cool, I'll suggest a few once I've got everyone's limits 💡");
      await saveState(state);
      await this.updateTripCard(state);
      return this.askWhen(state);
    }
    if (action.startsWith("when:")) {
      if (step !== "when") return ctx.answerCallbackQuery();
      await ctx.answerCallbackQuery();
      const which = action.slice(5);
      if (which === "other") return void (await this.say(state.chatId, "Type them, like “20–23 Nov” 👇"));
      const range = weekendRange(which);
      if (range) [state.trip.startDate, state.trip.endDate] = range;
      await saveState(state);
      await this.updateTripCard(state);
      return this.askExtras(state);
    }
    return ctx.answerCallbackQuery();
  }

  private async planNow(state: ChatState) {
    if (state.stage !== "listening" && state.stage !== "intro") return;
    await this.flush(state.chatId);
    state.listening = false;
    state.data.setup = undefined;
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

  private buffer(chatId: number, m: Heard, quietMs?: number) {
    const b = this.buffers.get(chatId) ?? { msgs: [] };
    b.msgs.push(m);
    clearTimeout(b.timer);
    this.buffers.set(chatId, b);
    if (b.msgs.length >= (this.opts.maxBatch ?? BATCH_MAX)) void this.flush(chatId);
    else b.timer = setTimeout(() => void this.flush(chatId), Math.min(quietMs ?? Infinity, this.opts.quietMs ?? BATCH_QUIET_MS));
  }

  /** Read everything buffered for a chat in one fast-model call. */
  async flush(chatId: number) {
    const b = this.buffers.get(chatId);
    if (!b?.msgs.length) return;
    clearTimeout(b.timer);
    const msgs = b.msgs.splice(0);
    const state = await loadState(chatId);
    const before = new Map(state.squad.map((p) => [p.id, p.city]));
    const knownLimits = new Set(state.squad.flatMap((p) => p.constraints.map((c) => c.id)));
    const datesBefore = state.trip.startDate;
    const placesBefore = state.mentioned.length;
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
    // Short, human acks: who joined, and anyone added by a friend gets an Undo.
    const proxied = new Set(applied.addedByOthers.map((x) => x.member.id));
    const fresh = state.squad.filter((p) => !before.has(p.id) && !proxied.has(p.id));
    const cityNow = state.squad.filter((p) => before.has(p.id) && !before.get(p.id) && p.city);
    const ack = [...fresh, ...cityNow].map((p) => `<b>${esc(p.name)}</b>${p.city ? ` (${esc(p.city)})` : ""}`);
    if (ack.length) await this.say(chatId, `👍 ${ack.join(", ")}`);

    for (const { member } of applied.addedByOthers) {
      const token = randomBytes(4).toString("hex");
      state.undo[token] = { memberId: member.id, addedBy: member.proxyFor ?? "" };
      await this.say(chatId, `➕ <b>${esc(member.name)}</b>${member.city ? ` (${esc(member.city)})` : ""} added`, new InlineKeyboard().text("Undo", `undo:${token}`));
    }
    // What Milo understood, so everyone can see it (and fix it later on the Heard card).
    const noted = state.squad
      .map((p) => ({ p, fresh: p.constraints.filter((c) => !knownLimits.has(c.id)) }))
      .filter((x) => x.fresh.length)
      .map(({ p, fresh }) => `<b>${esc(p.name)}</b>: ${fresh.map((c) => `${c.hard ? "🔒 " : ""}${esc(chipLabel(c))}`).join(", ")}`);
    if (noted.length) await this.say(chatId, `📝 Noted · ${noted.join(" · ")}`);
    await saveState(state);
    await this.updateTripCard(state);

    if (applied.intents.some((i) => i.kind === "plan_now")) return this.planNow(state);
    if (applied.intents.some((i) => i.kind === "pause")) {
      state.paused = true;
      await saveState(state);
      return this.say(chatId, "⏸ Paused. Tap <b>Resume Milo</b> on the Trip card when you want me back.");
    }
    // Step by step: move on when the chat answered the current question.
    const setup = state.data.setup;
    if (setup === "where" && state.mentioned.length > placesBefore) {
      state.trip.destination = state.mentioned.at(-1);
      if (!state.decisions.includes(`Going to ${state.trip.destination}`)) state.decisions.push(`Going to ${state.trip.destination}`);
      await saveState(state);
      await this.say(chatId, `📍 <b>${esc(state.trip.destination!)}</b>, nice!`);
      return this.askWhen(state);
    }
    if (setup === "when" && state.trip.startDate && state.trip.startDate !== datesBefore) {
      await this.say(chatId, `📅 Got it 👍`);
      return this.askExtras(state);
    }
    if (setup) return;
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
