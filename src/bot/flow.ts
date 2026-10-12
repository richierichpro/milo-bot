import { randomBytes } from "node:crypto";
import { InlineKeyboard, InputFile, type Context } from "grammy";
import { renderCard } from "../cards/render.js";
import * as t from "../cards/templates.js";
import { resolveAirport, suggestCities } from "../core/airports.js";
import { findDestinations, type DestinationShortlist } from "../core/squad.js";
import type { CallLogEntry, SquadMember } from "../core/types.js";
import type { Milo } from "./conversation.js";
import { apply, understand, type Heard } from "./listen.js";
import { dateRange, heardHtml, shortlistHtml } from "./render.js";
import { loadState, saveState, type ChatState } from "./state.js";
import { buttonLabel, cast, newVote, tick, veto, voterNames, type Vote, type VoteEvent } from "./votes.js";

// The planning conversation: Heard card → missing info, one question at a time →
// destination vote → Decided. Solving and the itinerary plug in through `next`.

const CITY_BUTTONS = ["Hyderabad", "Bengaluru", "Delhi", "Mumbai", "Pune", "Chennai", "Kolkata"];
const today = () => process.env.MILO_TODAY ?? new Date().toISOString().slice(0, 10);

/** city/dates go to one person; budget/food go to the whole group at once ("all"), each tap counted for whoever tapped. */
type Question = { kind: "city" | "dates" | "budget" | "food"; memberId: string; messageId?: number; pending?: string[]; answers?: Record<string, string> };
type FlowData = { fixing?: string; question?: Question; awaitingText?: Question; asked?: string[]; vote?: Vote; shortlist?: DestinationShortlist; receipts?: CallLogEntry[] };

const flow = (s: ChatState) => s.data as FlowData;

/**
 * A real Telegram tag, so the person gets notified. Friends without Telegram are
 * tagged through whoever added them (they answer for them).
 */
export const mention = (p: SquadMember) => {
  const id = p.telegramUserId ?? (p.proxyFor ? Number(p.proxyFor) : undefined);
  return id ? `<a href="tg://user?id=${id}">${t.esc(p.name)}</a>` : `<b>${t.esc(p.name)}</b>`;
};

/** Who may act for a squad member: themselves, or whoever added them if they're not on Telegram. */
export function actsFor(p: SquadMember, telegramUserId: number): boolean {
  return p.telegramUserId === telegramUserId || (!p.telegramUserId && p.proxyFor === String(telegramUserId));
}

export class PlanningFlow {
  /** Called once the destination is decided (Step 6 plugs in solving here). */
  next: (chatId: number) => Promise<void> = async (chatId) => {
    await this.milo.say(chatId, "Next I'll search flights and stays within everyone's limits. 🔎");
  };

  private timer?: ReturnType<typeof setInterval>;

  constructor(private milo: Milo) {
    milo.hooks.onPlanNow = (chatId) => this.start(chatId);
    milo.hooks.onCallback = (ctx, state) => this.onCallback(ctx, state);
    milo.hooks.onMessage = (state, heard) => this.onMessage(state, heard);
  }

  /** Re-check open votes every 30 s (deadlines, half-time pings). */
  startClock() {
    this.timer ??= setInterval(() => void this.tickAll(), 30_000);
    this.timer.unref?.();
  }
  stopClock() {
    clearInterval(this.timer);
  }

  // ---------- Cards ----------

  async sendCard(chatId: number, html: string, caption: string, keyboard?: InlineKeyboard, withoutMap?: () => string) {
    await this.milo.bot.api.sendChatAction(chatId, "upload_photo").catch(() => {});
    const r = await renderCard(html, withoutMap);
    return this.milo.send(chatId, () =>
      this.milo.bot.api.sendPhoto(chatId, new InputFile(r.png, "milo.png"), { caption: caption.slice(0, 1024), parse_mode: "HTML", reply_markup: keyboard }),
    );
  }

  // ---------- Heard ----------

  async start(chatId: number) {
    const s = await loadState(chatId);
    s.stage = "heard";
    s.pending = ["Everyone checks “what I heard”"];
    await saveState(s);
    await this.milo.updateTripCard(s);
    await this.sendHeard(s);
  }

  private async sendHeard(s: ChatState) {
    const kb = new InlineKeyboard().text("Looks right ✅", "heard_ok").row();
    s.squad.forEach((p, i) => {
      kb.text(`✏️ Fix ${p.name}'s`, `fix:${p.id}`);
      if (i % 2) kb.row();
    });
    await this.sendCard(s.chatId, heardHtml(s.squad), "📝 <b>Here's what I heard</b>\nAll good? 🔒 = I'll never break it", kb);
  }

  // ---------- Callbacks ----------

  private async onCallback(ctx: Context, s: ChatState): Promise<boolean> {
    const data = ctx.callbackQuery?.data ?? "";
    const tg = ctx.from!.id;
    const f = flow(s);

    if (data === "heard_ok") {
      if (s.stage !== "heard") { await ctx.answerCallbackQuery({ text: "Already confirmed 👍" }); return true; }
      await ctx.answerCallbackQuery({ text: "Great, thanks!" });
      s.stage = "questions";
      s.decisions.push("Everyone's limits confirmed");
      s.pending = [];
      await saveState(s);
      await this.askNext(s);
      return true;
    }

    if (data.startsWith("fix:")) {
      const p = s.squad.find((x) => x.id === data.slice(4));
      if (!p) { await ctx.answerCallbackQuery(); return true; }
      if (!actsFor(p, tg)) { await ctx.answerCallbackQuery({ text: `This one's for ${p.name}`, show_alert: true }); return true; }
      f.fixing = p.id;
      await saveState(s);
      await ctx.answerCallbackQuery();
      await this.milo.say(s.chatId, `✏️ ${mention(p)}, what should I change?`);
      return true;
    }

    if (data.startsWith("q:all:")) return this.groupAnswer(ctx, s, data.slice(6));
    if (data.startsWith("q:")) {
      const [, memberId, value] = data.split(":");
      const p = s.squad.find((x) => x.id === memberId);
      if (!p || f.question?.memberId !== memberId) { await ctx.answerCallbackQuery({ text: "That question's done." }); return true; }
      if (!actsFor(p, tg)) { await ctx.answerCallbackQuery({ text: `This one's for ${p.name}`, show_alert: true }); return true; }
      await ctx.answerCallbackQuery();
      if (value === "other") {
        f.awaitingText = f.question;
        await saveState(s);
        await this.milo.say(s.chatId, `${mention(p)}, just type it here 👇`);
        return true;
      }
      await this.answer(s, f.question!, value);
      return true;
    }

    if (data.startsWith("v:")) {
      const [, voteId, key] = data.split(":");
      const v = f.vote;
      if (!v || v.id !== voteId) { await ctx.answerCallbackQuery({ text: "This vote is closed." }); return true; }
      const r = cast(v, tg, key, s.squad);
      await ctx.answerCallbackQuery({ text: r.message });
      await saveState(s);
      await this.refreshVote(s);
      await this.handle(s, tick(v, Date.now()));
      return true;
    }

    if (data.startsWith("veto:")) {
      const [, voteId, key, memberId] = data.split(":");
      const v = f.vote;
      const p = s.squad.find((x) => x.id === memberId);
      if (!v || v.id !== voteId || !p) { await ctx.answerCallbackQuery(); return true; }
      if (!actsFor(p, tg)) { await ctx.answerCallbackQuery({ text: `This one's for ${p.name}`, show_alert: true }); return true; }
      veto(v, memberId, key);
      await ctx.answerCallbackQuery({ text: "Taken off the table." });
      const label = v.options.find((o) => o.key === key)?.label;
      await this.milo.say(s.chatId, `🚫 ${mention(p)} said no to <b>${t.esc(label ?? "")}</b>, so it's off the table.`);
      await saveState(s);
      await this.refreshVote(s);
      await this.handle(s, tick(v, Date.now()));
      return true;
    }
    return false;
  }

  /** Typed answers: a fix to someone's limits, or an "Other" reply. Returns true when handled. */
  private async onMessage(s: ChatState, heard: Heard): Promise<boolean> {
    const f = flow(s);
    const g = f.question;
    if (g?.memberId === "all" && g.kind === "budget") {
      const value = typedBudget(heard.text);
      const mine = (g.pending ?? []).map((id) => s.squad.find((p) => p.id === id)!).filter((p) => p && actsFor(p, heard.userId));
      const p = mine.find((x) => x.telegramUserId === heard.userId) ?? mine[0];
      if (value && p) {
        await this.milo.bot.api.setMessageReaction(s.chatId, heard.messageId, [{ type: "emoji", emoji: "👍" }]).catch(() => {});
        await this.recordPick(s, g, p, value);
        return true;
      }
    }
    const who = s.squad.find((p) => actsFor(p, heard.userId) && (p.id === f.fixing || p.id === f.awaitingText?.memberId));
    if (!who) return false;
    if (f.fixing === who.id) {
      f.fixing = undefined;
      // Read the fix as if this person said it; only their own row changes.
      const msg = { ...heard, name: who.name };
      const others = s.squad.filter((p) => p.id !== who.id);
      const u = await understand([msg], s, today(), who.name);
      const city = u.people.find((p) => p.action !== "remove" && p.name.toLowerCase() === who.name.toLowerCase())?.city;
      const before = JSON.stringify([who.city, who.constraints]);
      u.constraints = u.constraints.filter((c) => c.person.toLowerCase() === who.name.toLowerCase());
      u.people = [];
      u.trip = {};
      u.destinations_mentioned = [];
      u.intents = [];
      apply(s, u, [msg]);
      if (city) who.city = city;
      if (JSON.stringify([who.city, who.constraints]) === before) {
        f.fixing = who.id;
        await saveState(s);
        await this.milo.say(s.chatId, `🤔 ${mention(who)}, I didn't catch a change. Try like “budget 20k”, “I'm veg” or “flying from Pune”.`);
        return true;
      }
      s.squad = [...others, s.squad.find((p) => p.id === who.id)!].sort((a, b) => s.squad.indexOf(a) - s.squad.indexOf(b));
      await saveState(s);
      await this.milo.bot.api.setMessageReaction(s.chatId, heard.messageId, [{ type: "emoji", emoji: "👀" }]).catch(() => {});
      await this.sendHeard(s);
      return true;
    }
    if (f.awaitingText?.memberId === who.id) {
      const q = f.awaitingText;
      f.awaitingText = undefined;
      await this.answer(s, q, heard.text.trim());
      return true;
    }
    return false;
  }

  // ---------- Questions (only after planning starts, one at a time) ----------

  /** Cities first (needed to search), then dates, then each person's budget and food needs if nobody said. */
  private missing(s: ChatState): Question | undefined {
    const asked = new Set(flow(s).asked ?? []);
    const noCity = s.squad.find((p) => !p.city || !resolveAirport(p.city));
    if (noCity) return { kind: "city", memberId: noCity.id };
    if (!s.trip.startDate || !s.trip.endDate) return { kind: "dates", memberId: s.squad[0].id };
    const noBudget = s.squad.filter((p) => !asked.has(`budget:${p.id}`) && !p.constraints.some((c) => c.kind === "budget"));
    if (noBudget.length) return { kind: "budget", memberId: "all", pending: noBudget.map((p) => p.id), answers: {} };
    const noFood = s.squad.filter((p) => !asked.has(`food:${p.id}`) && !p.constraints.some((c) => c.kind === "food"));
    if (noFood.length) return { kind: "food", memberId: "all", pending: noFood.map((p) => p.id), answers: {} };
    return undefined;
  }

  private async askNext(s: ChatState) {
    const q = this.missing(s);
    const f = flow(s);
    f.question = q;
    await saveState(s);
    if (!q) {
      if (s.trip.destination) {
        s.stage = "solving";
        await saveState(s);
        return this.next(s.chatId);
      }
      return this.destinationVote(s);
    }
    if (q.memberId === "all") return this.ask(s, q, this.groupText(s, q), this.groupKeyboard(q));
    const p = s.squad.find((x) => x.id === q.memberId)!;
    if (q.kind === "city") {
      const kb = new InlineKeyboard();
      CITY_BUTTONS.forEach((c, i) => {
        kb.text(c, `q:${p.id}:${c}`);
        if (i % 3 === 2) kb.row();
      });
      kb.text("Other ✍️", `q:${p.id}:other`);
      const hint = p.city && !resolveAirport(p.city) ? ` I don't know an airport for “${t.esc(p.city)}”${suggestCities(p.city).length ? `: did you mean ${suggestCities(p.city).map((x) => `<b>${t.esc(x)}</b>`).join(" or ")}?` : "."}` : "";
      return this.ask(s, q, `🛫 ${mention(p)}, which city are you flying from?${hint}`, kb);
    }
    // Dates are typed: the next message from this person is the answer.
    flow(s).awaitingText = q;
    await this.ask(s, q, `📅 ${mention(p)}, which dates are we going? Just type them, like <i>20–23 Nov</i>`);
  }

  private async ask(s: ChatState, q: Question, html: string, kb?: InlineKeyboard) {
    const msg = await this.milo.say(s.chatId, html, kb);
    q.messageId = msg.message_id;
    await saveState(s);
  }

  /** The question turns into its answer, so everyone sees what was picked. */
  private async showAnswer(s: ChatState, q: Question, text: string) {
    if (!q.messageId) return;
    await this.milo.bot.api.editMessageText(s.chatId, q.messageId, text, { parse_mode: "HTML", reply_markup: new InlineKeyboard() }).catch(() => {});
  }

  // ---------- Group questions: everyone taps their own answer ----------

  private groupKeyboard(q: Question): InlineKeyboard | undefined {
    // Budgets are typed ("30k", "no limit"); food is a tap.
    return q.kind === "budget"
      ? undefined
      : new InlineKeyboard().text("Veg", "q:all:veg").text("Non-veg", "q:all:none").text("Jain", "q:all:jain").row().text("No preference", "q:all:none");
  }

  private groupText(s: ChatState, q: Question): string {
    const head = q.kind === "budget" ? "💸 <b>What's your max for the whole trip?</b> Just type it, like 25k or no limit" : "🍽 <b>Any food needs?</b> Tap yours 👇";
    const done = Object.entries(q.answers ?? {}).map(([id, label]) => `${t.esc(s.squad.find((p) => p.id === id)?.name ?? "?")}: ${label}`);
    const waiting = (q.pending ?? []).map((id) => s.squad.find((p) => p.id === id)).filter(Boolean).map((p) => mention(p!));
    return [head, done.length ? `✅ ${done.join(" · ")}` : "", waiting.length ? `⏳ ${waiting.join(", ")}` : ""].filter(Boolean).join("\n");
  }

  /** A tap counts for whoever tapped; if they've answered, it counts for a friend they added. */
  private async groupAnswer(ctx: Context, s: ChatState, value: string): Promise<boolean> {
    const f = flow(s);
    const q = f.question;
    if (!q || q.memberId !== "all") {
      await ctx.answerCallbackQuery({ text: "That question's done." });
      return true;
    }
    const tg = ctx.from!.id;
    const mine = (q.pending ?? []).map((id) => s.squad.find((p) => p.id === id)!).filter((p) => p && actsFor(p, tg));
    const p = mine.find((x) => x.telegramUserId === tg) ?? mine[0];
    if (!p) {
      await ctx.answerCallbackQuery({ text: s.squad.some((x) => actsFor(x, tg)) ? "You've answered 👍" : "Say you're in first 🙂" });
      return true;
    }
    if (value === "other") {
      await ctx.answerCallbackQuery();
      f.awaitingText = { ...q, memberId: p.id };
      await saveState(s);
      await this.milo.say(s.chatId, `${mention(p)}, type it here 👇`);
      return true;
    }
    const next = mine.find((x) => x.id !== p.id);
    await ctx.answerCallbackQuery({ text: `Got it${p.telegramUserId === tg ? "" : ` for ${p.name}`}${next ? `. Tap again for ${next.name}` : ""}` });
    await this.recordPick(s, q, p, value);
    return true;
  }

  private async recordPick(s: ChatState, q: Question, p: SquadMember, value: string) {
    const f = flow(s);
    const group = f.question?.memberId === "all" ? f.question : q;
    (f.asked ??= []).push(`${q.kind}:${p.id}`);
    const id = `${p.id}-${q.kind}-asked`;
    let label: string;
    if (q.kind === "budget") {
      const m = value.toLowerCase().replace(/[,₹\s]/g, "").match(/^(\d+(?:\.\d+)?)(k)?$/);
      const max = m ? Math.round(Number(m[1]) * (m[2] || Number(m[1]) < 1000 ? 1000 : 1)) : undefined;
      if (max) p.constraints.push({ id, hard: true, kind: "budget", max });
      label = max ? `max ${t.rupees(max)}` : "no limit";
    } else {
      if (value === "veg" || value === "jain") p.constraints.push({ id, hard: true, kind: "food", diet: value });
      label = value === "veg" ? "veg 🌱" : value === "jain" ? "Jain" : "no preference";
    }
    group.answers = { ...(group.answers ?? {}), [p.id]: label };
    group.pending = (group.pending ?? []).filter((x) => x !== p.id);
    await saveState(s);
    if (!group.messageId) return;
    const finished = !group.pending.length;
    await this.milo.bot.api
      .editMessageText(s.chatId, group.messageId, this.groupText(s, group), { parse_mode: "HTML", reply_markup: finished ? undefined : this.groupKeyboard(group) })
      .catch(() => {});
    if (finished) {
      await this.milo.updateTripCard(s);
      await this.askNext(s);
    }
  }

  private async answer(s: ChatState, q: Question, value: string) {
    const p = s.squad.find((x) => x.id === q.memberId)!;
    if (q.kind === "city") {
      if (!resolveAirport(value)) {
        p.city = value;
        await saveState(s);
        return this.askNext(s);
      }
      p.city = value.replace(/^./, (c) => c.toUpperCase());
      s.decisions.push(`${p.name} flies from ${p.city}`);
      await this.showAnswer(s, q, `🛫 ${mention(p)}: flying from <b>${t.esc(p.city)}</b> ✅`);
    } else if (q.kind === "budget" || q.kind === "food") {
      // A typed "Other" answer to the group question.
      return this.recordPick(s, q, p, value);    } else {
      const shown = () => (s.trip.startDate && s.trip.endDate ? `📅 ${mention(p)}: <b>${t.esc(dateRange(s.trip.startDate, s.trip.endDate))}</b> ✅` : "");
      const range = weekend(value);
      if (range) [s.trip.startDate, s.trip.endDate] = range;
      else {
        const u = await understand([{ messageId: 0, userId: p.telegramUserId ?? 0, name: p.name, text: `our dates: ${value}` }], s, today());
        if (u.trip.start_date && u.trip.end_date) [s.trip.startDate, s.trip.endDate] = [u.trip.start_date, u.trip.end_date];
      }
      if (shown()) await this.showAnswer(s, q, shown());
    }
    await saveState(s);
    await this.milo.updateTripCard(s);
    await this.askNext(s);
  }

  // ---------- Destination vote ----------

  private async destinationVote(s: ChatState) {
    s.stage = "destination_vote";
    s.pending = ["Vote: where are we going?"];
    await saveState(s);
    await this.milo.updateTripCard(s);
    const status = await this.milo.say(s.chatId, "🔎 Checking where everyone can fly to…");
    const receipts: CallLogEntry[] = [];
    let shortlist: DestinationShortlist;
    try {
      shortlist = await findDestinations(s.squad, { startDate: s.trip.startDate!, endDate: s.trip.endDate! }, { mentioned: s.mentioned, log: receipts });
    } catch (err) {
      return void (await this.milo.say(s.chatId, `😕 I couldn't search destinations: ${t.esc((err as Error).message)}`));
    }
    await this.milo.bot.api.editMessageText(s.chatId, status.message_id, `✓ Checked ${receipts.length} searches across ${new Set(receipts.map((r) => r.engine)).size} Google engines`).catch(() => {});

    if (!shortlist.options.length) return void (await this.milo.say(s.chatId, `😕 ${t.esc(shortlist.note ?? "No destination works for everyone.")} Tell me a place and I'll plan it.`));

    const v = newVote(
      randomBytes(3).toString("hex"),
      "Where are we going?",
      shortlist.options.map((o) => ({
        key: o.destination.id.replace(/[^a-z0-9]/gi, "").slice(-12),
        label: o.destination.name,
        sub: `≈ ${t.rupees(o.groupTotal / o.perPerson.length)} each`,
        costPerPerson: o.groupTotal / o.perPerson.length,
        fairnessGap: o.fairnessGap,
        breaks: o.perPerson.filter((x) => !x.withinBudget).map((x) => s.squad.find((m) => m.name === x.person)!.id),
      })),
      s.squad,
      Date.now(),
    );
    const f = flow(s);
    f.vote = v;
    f.shortlist = shortlist;
    f.receipts = receipts;
    const needs = v.options.filter((o) => o.breaks.length).map((o) => `${o.label} needs ${o.breaks.map((b) => s.squad.find((m) => m.id === b)?.name).join(" & ")}'s OK`);
    const msg = await this.sendCard(
      s.chatId,
      shortlistHtml(shortlist),
      `🗳 <b>Where are we going?</b> One vote each.${needs.length ? `\n<i>${t.esc(needs.join(" · "))}</i>` : ""}`,
      this.voteKeyboard(s, v),
    );
    v.messageId = msg.message_id;
    await saveState(s);
    this.startClock();
  }

  private voteKeyboard(s: ChatState, v: Vote): InlineKeyboard {
    const kb = new InlineKeyboard();
    v.options.forEach((o, i) => {
      if (!o.vetoedBy) kb.text(buttonLabel(v, o, s.squad, i), `v:${v.id}:${o.key}`).row();
    });
    for (const o of v.options)
      for (const m of o.breaks) if (!o.vetoedBy && !o.okBy.includes(m)) kb.text(`🚫 ${s.squad.find((p) => p.id === m)?.name}: no to ${o.label}`, `veto:${v.id}:${o.key}:${m}`).row();
    return kb;
  }

  private async refreshVote(s: ChatState) {
    const v = flow(s).vote;
    if (!v?.messageId || v.status === "closed") return;
    await this.milo.bot.api.editMessageReplyMarkup(s.chatId, v.messageId, { reply_markup: this.voteKeyboard(s, v) }).catch(() => {});
  }

  private async tickAll() {
    // Only chats with an open vote are loaded by the bot's own handlers; this is a light sweep.
    for (const chatId of this.openChats) {
      const s = await loadState(chatId);
      const v = flow(s).vote;
      if (v && v.status !== "closed") await this.handle(s, tick(v, Date.now()));
    }
  }
  private get openChats(): number[] {
    return [...this.milo.knownChats];
  }

  private async handle(s: ChatState, events: VoteEvent[]) {
    const v = flow(s).vote!;
    const names = (ids: string[]) => ids.map((id) => s.squad.find((p) => p.id === id)).filter(Boolean).map((p) => mention(p!)).join(", ");
    for (const e of events) {
      if (e.type === "ping") await this.milo.say(s.chatId, `⏰ Halfway through the vote: ${names(e.memberIds)}, your turn! 🗳`);
      if (e.type === "extended") await this.milo.say(s.chatId, `⏳ Not enough votes yet, so I've given it a bit longer. ${names(e.memberIds)}, please vote! 🗳`);
      if (e.type === "tie") await this.milo.say(s.chatId, `🤝 ${t.esc(e.reason)} Shout in the next 10 minutes if you object.`);
      if (e.type === "no_winner") await this.milo.say(s.chatId, `😕 ${t.esc(e.reason)} Tell me a place and I'll plan it.`);
      if (e.type === "closed") await this.decided(s, v, e.reason);
    }
    await saveState(s);
  }

  private async decided(s: ChatState, v: Vote, reason: string) {
    const o = v.options.find((x) => x.key === v.winner)!;
    const count = Object.values(v.ballots).filter((k) => k === o.key).length;
    if (v.messageId) await this.milo.bot.api.editMessageReplyMarkup(s.chatId, v.messageId, { reply_markup: new InlineKeyboard() }).catch(() => {});
    s.trip.destination = o.label;
    s.decisions.push(`Going to ${o.label} (${count}/${v.eligible.length} votes)`);
    s.pending = [];
    s.stage = "solving";
    await saveState(s);
    const okNote = o.breaks.length ? ` ${o.breaks.map((b) => s.squad.find((m) => m.id === b)?.name).join(" & ")} OK'd it; I'll still try to bring it within budget.` : "";
    await this.sendCard(s.chatId, t.decidedCard(v.question, o.label, `${count} of ${v.eligible.length} votes · ${o.sub ?? ""}`, `${reason}${okNote}`), `✅ <b>Decided: ${t.esc(o.label)}!</b> ${t.esc(voterNames(v, o.key, s.squad).join(", "))}`);
    await this.milo.updateTripCard(s);
    await this.next(s.chatId);
  }
}

/** "this_weekend" / "next_weekend" → Friday–Sunday. */
function weekend(value: string): [string, string] | undefined {
  if (value !== "this_weekend" && value !== "next_weekend") return undefined;
  const d = new Date(`${today()}T00:00:00Z`);
  const toFri = (5 - d.getUTCDay() + 7) % 7 + (value === "next_weekend" ? 7 : 0);
  const fri = new Date(d.getTime() + toFri * 86_400_000);
  const sun = new Date(fri.getTime() + 2 * 86_400_000);
  return [fri.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
}

/** A typed budget: "30000 is my budget", "25k", "₹30,000", "1.5 lakh", "no limit". Undefined when it isn't one. */
export function typedBudget(text: string): string | undefined {
  const x = text.toLowerCase().replace(/[,₹]/g, "");
  if (/\b(no limit|no budget|unlimited|no cap|anything)\b/.test(x)) return "none";
  const m = x.match(/(\d+(?:\.\d+)?)\s*(k|thousand|l|lakh|lac)?\b/);
  if (!m) return undefined;
  const num = Number(m[1]);
  // A bare small number ("30") means thousands.
  const n = num * (m[2]?.startsWith("l") ? 100_000 : m[2] || num < 1000 ? 1000 : 1);
  return n >= 1000 ? String(Math.round(n)) : undefined;
}
