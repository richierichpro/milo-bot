import { esc, rupees } from "../cards/templates.js";
import type { CandidatePool, Trip } from "../core/gather.js";
import { chooseHotel, problems, solve } from "../core/solve.js";
import type { Hotel, SquadMember } from "../core/types.js";
import { mention } from "./flow.js";

// The group picks the stay: three real Google Hotels options that keep everyone
// within their limits (best pick, cheapest, top rated), one tap each.

export type HotelOption = { hotelId: string; label: string; each: number };
export type HotelVote = { id: string; options: HotelOption[]; votes: Record<string, number>; messageId?: number; done?: boolean };

/** Options are numbered 1, 2, 3 on the card and the buttons. */
export const letter = (i: number) => String(i + 1);

/** Up to three stays that break nobody's hard limits, each with what one person pays in all. */
export function hotelOptions(pool: CandidatePool, trip: Trip, squad: SquadMember[], priceFirst: string[]): HotelOption[] {
  const priced = pool.hotels.filter((h) => h.pricePerNight);
  const each = (h: Hotel) => {
    const sol = solve(pool, trip, squad, { hotel: h, priceFirst });
    return { ok: problems(sol, squad).length === 0, each: Math.round(sol.costs.reduce((a, c) => a + c.total, 0) / Math.max(1, sol.costs.length)) };
  };
  const scored = priced.map((h) => ({ h, ...each(h) }));
  const feasible = scored.filter((x) => x.ok);
  const list = feasible.length ? feasible : scored;
  const out: { h: Hotel; label: string; each: number }[] = [];
  const add = (x: (typeof list)[number] | undefined, label: string) => {
    if (x && !out.some((o) => o.h.id === x.h.id)) out.push({ h: x.h, label, each: x.each });
  };
  const best = chooseHotel({ ...pool, hotels: list.map((x) => x.h) });
  add(list.find((x) => x.h.id === best?.id), "Best pick");
  add([...list].sort((a, b) => a.h.pricePerNight! - b.h.pricePerNight!).find((x) => !out.some((o) => o.h.id === x.h.id)), "Cheapest");
  add([...list].sort((a, b) => (b.h.rating ?? 0) - (a.h.rating ?? 0) || (b.h.reviews ?? 0) - (a.h.reviews ?? 0)).find((x) => !out.some((o) => o.h.id === x.h.id)), "Top rated");
  for (const x of list) if (out.length < 3) add(x, "Also good");
  return out.map((o) => ({ hotelId: o.h.id, label: o.label, each: o.each }));
}

/** The caption under the one hotel card: a heading, who picked what, who's left. Fits Telegram's 1024-character caption. */
export function hotelVoteText(v: HotelVote, hotels: Hotel[], squad: SquadMember[]): string {
  const rows = v.options.map((o, i) => {
    const h = hotels.find((x) => x.id === o.hotelId);
    const who = squad.filter((p) => v.votes[p.id] === i).map((p) => esc(p.name));
    const link = h?.link ?? h?.source.url;
    const name = esc(h?.name ?? "?");
    return `<b>${letter(i)}</b> · ${link ? `<a href="${esc(link)}">${name}</a>` : name}${who.length ? ` · 🗳 ${who.join(", ")}` : ""}`;
  });
  const waiting = squad.filter((p) => v.votes[p.id] === undefined).map((p) => mention(p));
  const head = v.done ? "🏨 <b>Stay picked!</b>" : "🏨 <b>Time to pick your stay!</b>\nThree options that keep everyone within budget. Tap <b>1</b>, <b>2</b> or <b>3</b> 👇";
  const text = [head, "", ...rows, !v.done && waiting.length ? `\n⏳ ${waiting.join(", ")}` : ""].filter((x) => x !== "").join("\n");
  return text.length <= 1024 ? text : text.replace(/<a href="[^"]*">([^<]*)<\/a>/g, "$1").slice(0, 1024);
}

/** The vote is settled when everyone has voted, or one option has more than half the squad. Ties go to the cheaper stay. */
export function hotelWinner(v: HotelVote, squadSize: number): number | undefined {
  const tally = v.options.map((_, i) => Object.values(v.votes).filter((x) => x === i).length);
  const top = Math.max(...tally);
  const voted = Object.keys(v.votes).length;
  if (top * 2 <= squadSize && voted < squadSize) return undefined;
  const leaders = tally.flatMap((n, i) => (n === top ? [i] : []));
  return leaders.sort((a, b) => v.options[a].each - v.options[b].each)[0];
}
