import { randomBytes } from "node:crypto";
import { InlineKeyboard, InputFile, InputMediaBuilder, type Context } from "grammy";
import { esc } from "../cards/templates.js";
import { gatherCandidates, type CandidatePool, type Trip } from "../core/gather.js";
import { planTrip, type TripPlan } from "../core/planner.js";
import { bookingList, postPlan, sourcesMessages } from "./postplan.js";
import { formatINR } from "../core/money.js";
import { budgetCompromises, problems, solve, type Compromise, type Solution } from "../core/solve.js";
import type { SquadMember } from "../core/types.js";
import type { Milo } from "./conversation.js";
import { actsFor, mention, type PlanningFlow } from "./flow.js";
import { loadState, saveState, type ChatState } from "./state.js";
import { newQuickVote, quickTick, type QuickVote } from "./votes.js";
import { hotelOptions, hotelVoteText, hotelWinner, letter, type HotelVote } from "./hotelvote.js";
import { renderCard } from "../cards/render.js";
import { hotelChoiceCard } from "../cards/templates.js";
import { flightsHtml } from "./render.js";

// Solve within everyone's limits; when a hard limit breaks, ask only the person
// affected, with 2–3 real options. Changes that touch everyone get a quick 👍/👎.

type SolveData = {
  choice?: { priceFirst: string[]; hotelId?: string };
  asking?: { memberId: string; options: Compromise[] };
  quick?: QuickVote & { option: Compromise; by: string };
  hotelVote?: HotelVote;
  flightsShown?: boolean;
};
const sd = (s: ChatState) => ((s.data.solve ??= {}) as SolveData);
const tripOf = (s: ChatState): Trip => ({ destination: s.trip.destination!, startDate: s.trip.startDate!, endDate: s.trip.endDate!, interests: s.trip.interests });

/** "▰▰▰▱▱▱▱▱▱▱" */
export const bar = (done: number, total: number, width = 10) => {
  const n = Math.max(0, Math.min(width, Math.round((done / Math.max(1, total)) * width)));
  return "▰".repeat(n) + "▱".repeat(width - n);
};

export class SolvingFlow {
  /** Pools stay in memory; after a restart they're rebuilt from the search cache for free. */
  readonly pools = new Map<number, CandidatePool>();
  /** Called once every hard limit passes or is waived: build and post the itinerary. */
  next: (chatId: number, sol: Solution, pool: CandidatePool) => Promise<void> = (chatId, sol, pool) => this.itinerary(chatId, sol, pool);

  private async itinerary(chatId: number, sol: Solution, pool: CandidatePool) {
    const s = await loadState(chatId);
    await this.milo.bot.api.sendChatAction(chatId, "typing").catch(() => {});
    const status = await this.milo.say(chatId, `🗺 Planning your trip…\n${bar(1, 5)}`);
    let step = 1;
    const plan = await planTrip(pool, tripOf(s), sol, s.squad, {
      onProgress: (text) => void this.milo.bot.api.editMessageText(chatId, status.message_id, `${friendly(text)}\n${bar(++step, 5)}`).catch(() => {}),
    });
    await this.milo.bot.api.deleteMessage(chatId, status.message_id).catch(() => {});
    s.data.plan = plan;
    s.stage = "done";
    s.decisions.push(`Plan ready: ${plan.title}`);
    s.pending = [];
    await saveState(s);
    await postPlan(this.milo, s, plan);
    await this.milo.updateTripCard(s);
  }

  constructor(private milo: Milo, flow: PlanningFlow) {
    flow.next = (chatId) => this.start(chatId);
    const prev = milo.hooks.onCallback;
    milo.hooks.onCallback = async (ctx, s) => (await this.onCallback(ctx, s)) || prev(ctx, s);
  }

  async pool(s: ChatState, onProgress?: (text: string) => void): Promise<CandidatePool> {
    const hit = this.pools.get(s.chatId);
    if (hit) return hit;
    const pool = await gatherCandidates(tripOf(s), s.squad, onProgress);
    this.pools.set(s.chatId, pool);
    return pool;
  }

  async start(chatId: number) {
    const s = await loadState(chatId);
    s.stage = "solving";
    s.pending = ["Searching within everyone's limits"];
    await saveState(s);
    await this.milo.updateTripCard(s);
    await this.milo.bot.api.sendChatAction(chatId, "typing").catch(() => {});

    // One self-updating status message with a progress bar.
    const status = await this.milo.say(chatId, `✈️ Finding flights for everyone…\n${bar(0, 1)}`);
    let started = 0;
    let lastEdit = 0;
    const pool = await this.pool(s, (text) => {
      started++;
      const now = Date.now();
      if (now - lastEdit < 1200) return;
      lastEdit = now;
      void this.milo.bot.api.editMessageText(chatId, status.message_id, `${friendly(text)}\n${bar(started, started + 4)}`).catch(() => {});
    });
    await this.milo.bot.api.deleteMessage(chatId, status.message_id).catch(() => {});
    await this.check(s, pool);
  }

  private current(s: ChatState, pool: CandidatePool): Solution {
    const c = sd(s).choice;
    return solve(pool, tripOf(s), s.squad, { priceFirst: c?.priceFirst, hotel: c?.hotelId ? pool.hotels.find((h) => h.id === c.hotelId) : undefined });
  }

  /** Check every hard limit; ask about the first one that breaks, or move on. */
  private async check(s: ChatState, pool: CandidatePool): Promise<void> {
    const sol = this.current(s, pool);
    const broken = problems(sol, s.squad);
    if (!broken.length) {
      // Everyone's limits are met: the group picks the stay once, then Milo builds the days.
      if (!sd(s).hotelVote?.done) return this.startHotelVote(s, pool, sol);
      s.stage = "planning";
      s.pending = [];
      s.decisions.push(`Everyone's hard limits met${s.squad.some((p) => p.constraints.some((c) => c.waived)) ? " (with agreed exceptions)" : ""}`);
      await saveState(s);
      await this.milo.updateTripCard(s);
      return this.next(s.chatId, sol, pool);
    }
    const { member, check } = broken[0];
    s.stage = "negotiating";
    s.pending = [`${member.name} picks how to handle a limit`];
    await saveState(s);
    await this.milo.updateTripCard(s);

    if (check.constraint.kind === "budget") {
      const options = budgetCompromises(pool, tripOf(s), s.squad, sol, member, check.constraint.max);
      sd(s).asking = { memberId: member.id, options };
      await saveState(s);
      const now = sol.costs.find((c) => c.person === member.name)!.total;
      const lines = options.map(
        (o, i) =>
          `<b>${String.fromCharCode(65 + i)}</b>: ${esc(o.label)} → <b>${formatINR(o.total ?? 0)}</b>${o.stillOver ? ` <i>(still ${formatINR(o.stillOver)} over)</i>` : ""}${o.affects.length ? `\n     <i>changes the stay for ${esc(o.affects.join(", "))}</i>` : ""}`,
      );
      const kb = new InlineKeyboard();
      options.forEach((_, i) => kb.text(String.fromCharCode(65 + i), `neg:${member.id}:${i}`));
      return void (await this.milo.say(
        s.chatId,
        `💸 ${mention(member)}, ${esc(s.trip.destination ?? "")} comes to <b>${formatINR(now)}</b> for you, <b>${formatINR(now - check.constraint.max)} over</b> your cap.\n\n${lines.join("\n")}\n\nYour call 🙂`,
        kb,
      ));
    }

    // Any other hard limit that can't be met: the person can keep it (and Milo flags it) or let it go.
    const options: Compromise[] = [{ key: "go_over", label: `Let this one go: ${check.evidence}`, affects: [], apply: { waive: "let this limit go" } }];
    sd(s).asking = { memberId: member.id, options };
    await saveState(s);
    await this.milo.say(s.chatId, `⚠️ ${mention(member)}, I can't meet one of your limits with what's available: ${esc(check.evidence)}.`, new InlineKeyboard().text("OK, let it go", `neg:${member.id}:0`));
  }

  private async onCallback(ctx: Context, s: ChatState): Promise<boolean> {
    const data = ctx.callbackQuery?.data ?? "";
    const tg = ctx.from!.id;
    if (data.startsWith("neg:")) {
      const [, memberId, idx] = data.split(":");
      const ask = sd(s).asking;
      const member = s.squad.find((p) => p.id === memberId);
      if (!ask || ask.memberId !== memberId || !member) { await ctx.answerCallbackQuery({ text: "That question's done." }); return true; }
      if (!actsFor(member, tg)) { await ctx.answerCallbackQuery({ text: `This one's for ${member.name}`, show_alert: true }); return true; }
      const option = ask.options[Number(idx)];
      await ctx.answerCallbackQuery({ text: "Got it!" });
      sd(s).asking = undefined;
      if (option.affects.length) {
        await this.quickVote(s, member, option);
        return true;
      }
      await this.applyOption(s, member, option);
      return true;
    }
    if (data.startsWith("hv:")) {
      const [, id, idx] = data.split(":");
      const v = sd(s).hotelVote;
      if (!v || v.id !== id || v.done) { await ctx.answerCallbackQuery({ text: "The stay's already picked." }); return true; }
      // A tap counts for whoever tapped; once they've voted, for a friend they added who hasn't.
      const mine = s.squad.filter((p) => actsFor(p, tg));
      if (!mine.length) { await ctx.answerCallbackQuery({ text: "Only the squad votes on this." }); return true; }
      const voter = mine.find((p) => p.telegramUserId === tg && v.votes[p.id] === undefined) ?? mine.find((p) => v.votes[p.id] === undefined) ?? mine.find((p) => p.telegramUserId === tg) ?? mine[0];
      v.votes[voter.id] = Number(idx);
      await ctx.answerCallbackQuery({ text: `${letter(Number(idx))} for ${voter.name} 👍` });
      await saveState(s);
      await this.settleHotelVote(s);
      return true;
    }
    if (data === "booking") {
      const plan = s.data.plan as TripPlan | undefined;
      await ctx.answerCallbackQuery();
      if (plan) await this.milo.say(s.chatId, bookingList(plan));
      return true;
    }
    if (data === "sources") {
      const plan = s.data.plan as TripPlan | undefined;
      await ctx.answerCallbackQuery();
      if (!plan) return true;
      for (const m of sourcesMessages(plan)) await this.milo.say(s.chatId, m);
      return true;
    }
    if (data.startsWith("qv:")) {
      const [, id, dir] = data.split(":");
      const q = sd(s).quick;
      if (!q || q.id !== id || q.status !== "open") { await ctx.answerCallbackQuery({ text: "This one's settled." }); return true; }
      const voter = s.squad.find((p) => actsFor(p, tg) && !q.up.includes(p.id) && !q.down.includes(p.id)) ?? s.squad.find((p) => actsFor(p, tg));
      if (!voter) { await ctx.answerCallbackQuery({ text: "Only the squad votes on this." }); return true; }
      q.up = q.up.filter((x) => x !== voter.id);
      q.down = q.down.filter((x) => x !== voter.id);
      (dir === "up" ? q.up : q.down).push(voter.id);
      await ctx.answerCallbackQuery({ text: dir === "up" ? "👍 noted" : "👎 noted" });
      await this.settleQuick(s);
      return true;
    }
    return false;
  }

  private async startHotelVote(s: ChatState, pool: CandidatePool, sol: Solution): Promise<void> {
    const options = hotelOptions(pool, tripOf(s), s.squad, sd(s).choice?.priceFirst ?? []);
    const v: HotelVote = { id: randomBytes(3).toString("hex"), options, votes: {} };
    sd(s).hotelVote = v;
    if (options.length < 2) {
      v.done = true;
      if (options[0]) (sd(s).choice ??= { priceFirst: [] }).hotelId = options[0].hotelId;
      await saveState(s);
      return this.check(s, pool);
    }
    s.stage = "hotel_vote";
    s.pending = ["Everyone picks the stay"];
    await saveState(s);
    await this.milo.updateTripCard(s);
    const chatId = s.chatId;
    const api = this.milo.bot.api;
    // Flights first: everyone sees how they get there, then the group picks the stay.
    if (!sd(s).flightsShown) await this.showFlights(s, sol);
    await api.sendChatAction(chatId, "upload_photo").catch(() => {});
    // One card with all three stays; the vote buttons sit right under it.
    const hotels = options.map((o) => pool.hotels.find((h) => h.id === o.hotelId)!);
    const card = hotelChoiceCard(
      hotels.map((h, i) => ({ number: i + 1, tag: options[i].label, name: h.name, photo: h.thumbnail, rating: h.rating, reviews: h.reviews, stars: h.stars, perNight: h.pricePerNight, each: options[i].each })),
      sol.nights,
      sol.rooms,
    );
    const png = (await renderCard(card)).png;
    const kb = new InlineKeyboard();
    options.forEach((_, i) => kb.text(letter(i), `hv:${v.id}:${i}`));
    const msg = await this.milo.send(chatId, () => api.sendPhoto(chatId, new InputFile(png, "stays.png"), { caption: hotelVoteText(v, pool.hotels, s.squad), parse_mode: "HTML", reply_markup: kb }));
    v.messageId = msg.message_id;
    await saveState(s);
  }

  private async showFlights(s: ChatState, sol: Solution) {
    const chatId = s.chatId;
    await this.milo.bot.api.sendChatAction(chatId, "upload_photo").catch(() => {});
    const png = (await renderCard(flightsHtml(s.trip.destination ?? "", sol.flights, sol.extraVsCheapest))).png;
    const clock = (t?: string) => t?.slice(11, 16) ?? "?";
    const rows = sol.flights.map((f) =>
      f.out ? `<b>${esc(f.person)}</b>: <code>${esc(f.out.from)} ${clock(f.out.departTime)} → ${esc(f.out.to)} ${clock(f.out.arriveTime)}</code>${f.back ? ` · back <code>${clock(f.back.departTime)}</code>` : ""}` : `<b>${esc(f.person)}</b>: no flight found`,
    );
    const w = sol.arrivalWindow;
    const spread = w ? Math.round((Date.parse(`${w.last.replace(" ", "T")}:00Z`) - Date.parse(`${w.first.replace(" ", "T")}:00Z`)) / 60_000) : undefined;
    const together = spread !== undefined && spread >= 0 && spread <= 120 ? ` · everyone lands within <b>${spread < 60 ? `${spread} min` : `${Math.floor(spread / 60)}h ${spread % 60}m`}</b>` : "";
    const caption = `✈️ <b>Your flights</b>${together}\n\n${rows.join("\n")}`.slice(0, 1024);
    await this.milo.send(chatId, () => this.milo.bot.api.sendPhoto(chatId, new InputFile(png, "flights.png"), { caption, parse_mode: "HTML" }));
    sd(s).flightsShown = true;
    await saveState(s);
  }

  private async settleHotelVote(s: ChatState) {
    const v = sd(s).hotelVote;
    if (!v || v.done) return;
    const pool = await this.pool(s);
    const win = hotelWinner(v, s.squad.length);
    if (win !== undefined) v.done = true;
    const kb = new InlineKeyboard();
    if (!v.done) v.options.forEach((_, i) => kb.text(letter(i), `hv:${v.id}:${i}`));
    if (v.messageId) await this.milo.bot.api.editMessageCaption(s.chatId, v.messageId, { caption: hotelVoteText(v, pool.hotels, s.squad), parse_mode: "HTML", reply_markup: v.done ? undefined : kb }).catch(() => {});
    if (win === undefined) { await saveState(s); return; }
    const pick = v.options[win];
    const hotel = pool.hotels.find((h) => h.id === pick.hotelId);
    (sd(s).choice ??= { priceFirst: [] }).hotelId = pick.hotelId;
    s.decisions.push(`Stay: ${hotel?.name ?? "?"}`);
    await saveState(s);
    await this.milo.say(s.chatId, `🏨 Going with <b>${esc((hotel?.name ?? "").replace(/[.\s]+$/, ""))}</b>! Building your days now…`);
    await this.check(s, pool);
  }

  private async quickVote(s: ChatState, member: SquadMember, option: Compromise) {
    const pool = await this.pool(s);
    const before = this.current(s, pool);
    const after = solve(pool, tripOf(s), s.squad, { priceFirst: option.apply.priceFirst ?? sd(s).choice?.priceFirst, hotel: option.apply.hotelId ? pool.hotels.find((h) => h.id === option.apply.hotelId) : before.hotel });
    const diff = (name: string) => (after.costs.find((c) => c.person === name)?.total ?? 0) - (before.costs.find((c) => c.person === name)?.total ?? 0);
    const q = { ...newQuickVote(randomBytes(3).toString("hex"), s.squad, Date.now()), option, by: member.id };
    q.up.push(member.id);
    sd(s).quick = q;
    await saveState(s);
    const changes = option.affects.map((n) => `${n} ${diff(n) <= 0 ? `saves ${formatINR(-diff(n))}` : `pays ${formatINR(diff(n))} more`}`).join(", ");
    await this.milo.say(
      s.chatId,
      `🏨 ${esc(member.name)} picked a cheaper stay. ${esc(changes)}.\nOK? 👍`,
      new InlineKeyboard().text("👍", `qv:${q.id}:up`).text("👎", `qv:${q.id}:down`),
    );
    await this.settleQuick(s);
  }

  private async settleQuick(s: ChatState) {
    const q = sd(s).quick;
    if (!q) return;
    const status = quickTick(q, Date.now());
    await saveState(s);
    if (status === "open") return;
    const member = s.squad.find((p) => p.id === q.by)!;
    sd(s).quick = undefined;
    if (status === "passed") {
      await this.milo.say(s.chatId, `✅ Going with it.`);
      return this.applyOption(s, member, q.option);
    }
    await this.milo.say(s.chatId, `👎 Most of you said no, so the stay stays as it is. ${esc(member.name)}, here are your other options:`);
    const pool = await this.pool(s);
    await this.check(s, pool);
  }

  private async applyOption(s: ChatState, member: SquadMember, o: Compromise) {
    const choice = (sd(s).choice ??= { priceFirst: [] });
    if (o.apply.priceFirst) choice.priceFirst = o.apply.priceFirst;
    if (o.apply.hotelId) choice.hotelId = o.apply.hotelId;
    if (o.apply.waive) {
      const pool = await this.pool(s);
      const sol = this.current(s, pool);
      const broken = problems(sol, s.squad).find((x) => x.member.id === member.id);
      const c = broken && member.constraints.find((x) => x.id === broken.check.constraint.id);
      if (c) c.waived = o.apply.waive.replace(/^go /, "go ");
    }
    s.decisions.push(`${member.name}: ${o.label}`);
    await saveState(s);
    const pool = await this.pool(s);
    await this.check(s, pool);
  }
}

/** Progress in plain words: what Milo is doing for the group, not which search or model it's calling. */
function friendly(step: string): string {
  if (/flights/i.test(step)) return "✈️ Finding flights for everyone…";
  if (/hotels/i.test(step)) return "🏨 Finding a stay that fits…";
  if (/maps|places/i.test(step)) return "📍 Finding the best things to do…";
  if (/transfer/i.test(step)) return "🗺 Planning your trip…";
  if (/arrange/i.test(step)) return "🧭 Building your itinerary…";
  if (/checking every/i.test(step)) return "✅ Double-checking everything…";
  if (/travel times/i.test(step)) return "🚕 Working out travel times…";
  return "🗺 Planning your trip…";
}
