import { InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import { renderCard } from "../cards/render.js";
import * as t from "../cards/templates.js";
import { checkPerson } from "../core/constraints.js";
import type { TripPlan } from "../core/planner.js";
import type { Day, SquadMember } from "../core/types.js";
import type { Milo } from "./conversation.js";
import { costHtml, dateRange, dayLabel, engineLabel, flightsHtml, hotelHtml, passHtml, proofText, timeAgo } from "./render.js";
import type { ChatState } from "./state.js";

// Posts the finished plan: albums of cards, each followed by one short text with
// the key facts and source links (Telegram images aren't clickable).

export const TEXT_MAX = 4096;
export const CAPTION_MAX = 1024;
const e = t.esc;
const link = (url: string | undefined, label: string) => (url ? `<a href="${e(url)}">${e(label)}</a>` : e(label));

/** Day card input from a planned day. */
export function dayData(day: Day, index: number, plan: TripPlan, now = Date.now()): t.DayData {
  const stops: t.DayStop[] = [];
  for (const l of day.logistics?.filter((x) => x.at === "start") ?? []) stops.push({ time: l.time, name: l.label, proof: "", kind: "logistics" });
  for (const s of day.stops) {
    const p = s.kind === "place" ? s.item : undefined;
    stops.push({
      time: s.time,
      name: s.kind === "place" ? s.item.name : s.item.title,
      category: s.kind === "place" ? s.item.category : `Event · ${s.item.dateText ?? ""}`,
      rating: p?.rating,
      reviews: p?.reviews,
      price: p?.prices?.admission[0]?.priceText ?? p?.priceLevel,
      note: s.why || undefined,
      photo: s.item.thumbnail,
      proof: `${proofText(s.item.source, now)}${s.hoursNote ? ` · ${s.hoursNote}` : ""}`,
      lat: p?.lat,
      lng: p?.lng,
      hop: s.hop,
    });
  }
  for (const l of day.logistics?.filter((x) => x.at === "end") ?? []) stops.push({ time: l.time, name: l.label, proof: "", kind: "logistics" });
  const h = plan.solution.hotel;
  return {
    index,
    date: dayLabel(day.date),
    title: day.title,
    stops,
    leaveBy: day.leaveBy,
    travel: day.travelMinutes ? `≈ ${day.travelMinutes} min` : undefined,
    hotel: h ? { lat: h.lat, lng: h.lng, name: h.name } : undefined,
  };
}

/** Text after an album: bold names, monospace times, italic proof, links; long parts in an expandable quote. */
export function flightsText(plan: TripPlan): string {
  const f = plan.solution.flights;
  const rows = f.map(
    (p) =>
      `✈️ <b>${e(p.person)}</b>: <code>${e(p.out?.from ?? "?")} ${e(p.out?.departTime.slice(11) ?? "")} → ${e(p.out?.to ?? "?")} ${e(p.out?.arriveTime.slice(11) ?? "")}</code> · back <code>${e(p.back?.departTime.slice(11) ?? "?")}</code> · ${link(p.out?.source.url, "Google Flights")}`,
  );
  const h = plan.solution.hotel;
  return [
    `🏨 <b>${e(h?.name ?? "No hotel found")}</b>${h?.pricePerNight ? ` · ${t.rupees(h.pricePerNight)}/night` : ""}${h ? ` · ${link(h.link ?? h.source.url, "Google Hotels")}` : ""}`,
    "",
    ...rows,
    "",
    `<i>Every item is a live Google result (${plan.verification.verified}/${plan.verification.total} verified).</i>`,
  ].join("\n");
}

export function daysText(plan: TripPlan): string {
  const blocks = plan.days.map((d, i) => {
    const lines = d.stops.map((s) => `<code>${s.time}</code> ${s.kind === "place" ? "📍" : "🎟"} ${link(s.kind === "place" ? s.item.mapsUrl : s.item.link, s.kind === "place" ? s.item.name : s.item.title)}`);
    return `<b>Day ${i + 1} · ${e(dayLabel(d.date))}</b>${d.leaveBy ? ` · leave <code>${d.leaveBy}</code>` : ""}\n${lines.join("\n") || "<i>free</i>"}`;
  });
  return `📍 <b>Your days</b>, with map links:\n<blockquote expandable>${blocks.join("\n\n")}</blockquote>`;
}

export function passText(plan: TripPlan, squad: SquadMember[]): string {
  return squad
    .map((p) => {
      const checks = plan.checks[p.id] ?? [];
      const ok = checks.filter((c) => !c.pending && c.ok).length;
      const waived = checks.filter((c) => c.waived).length;
      const all = checks.filter((c) => !c.pending).length;
      return `${ok === all ? "✅" : "⚠️"} <b>${e(p.name)}</b>: ${ok}/${all} met${waived ? ` (${waived} agreed exception)` : ""}`;
    })
    .join("\n");
}

/** Every search and every dropped item, for the "See sources" button. Split into ≤4096-char messages. */
export function sourcesMessages(plan: TripPlan, now = Date.now()): string[] {
  const searches = plan.receipts.map((r) => `• ${e(engineLabel(r.engine))}: ${e(r.summary)} <i>(${r.source}, ${r.ms} ms)</i>`);
  const drops = plan.drops.map((d) => `• ✗ ${e(d.name)}: <i>${e(d.reason)}</i>`);
  const head = `🔎 <b>Sources</b> · ${plan.receipts.length} searches across ${new Set(plan.receipts.map((r) => r.engine)).size} Google engines · checked ${timeAgo(plan.createdAt, now)}`;
  const parts = [`${head}\n<blockquote expandable>${searches.join("\n")}</blockquote>`, `🗑 <b>Left out</b> (${drops.length})\n<blockquote expandable>${drops.join("\n") || "nothing"}</blockquote>`];
  return parts.flatMap((p) => (p.length <= TEXT_MAX ? [p] : chunk(p)));
}

function chunk(html: string): string[] {
  // Split inside the quote on line breaks, keeping each piece valid HTML.
  const [head, body] = html.split("<blockquote expandable>");
  const lines = body.replace("</blockquote>", "").split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if ((head + cur.join("\n") + l).length > TEXT_MAX - 60) {
      out.push(`${out.length ? "" : head}<blockquote expandable>${cur.join("\n")}</blockquote>`);
      cur = [];
    }
    cur.push(l);
  }
  out.push(`${out.length ? "" : head}<blockquote expandable>${cur.join("\n")}</blockquote>`);
  return out;
}

export async function postPlan(milo: Milo, s: ChatState, plan: TripPlan) {
  const chatId = s.chatId;
  const api = milo.bot.api;
  const now = Date.now();
  const sol = plan.solution;
  const render = async (html: string, withoutMap?: () => string) => (await renderCard(html, withoutMap)).png;
  const album = async (pngs: Buffer[], caption: string) => {
    await api.sendChatAction(chatId, "upload_photo").catch(() => {});
    const media = pngs.map((png, i) => InputMediaBuilder.photo(new InputFile(png, `milo-${i}.png`), i === 0 ? { caption: caption.slice(0, CAPTION_MAX), parse_mode: "HTML" } : {}));
    return milo.send(chatId, () => api.sendMediaGroup(chatId, media));
  };

  const avg = sol.costs.reduce((a, c) => a + c.total, 0) / Math.max(1, sol.costs.length);
  const header = t.headerCard({
    title: plan.title,
    destination: plan.trip.destination,
    dates: dateRange(plan.trip.startDate, plan.trip.endDate),
    perPerson: avg,
    summary: plan.summary,
    squad: s.squad.map((p) => p.name),
    verified: plan.verification,
    searches: plan.receipts.length,
  });
  await album(
    [await render(header), await render(flightsHtml(plan.trip.destination, sol.flights, sol.extraVsCheapest, now)), ...(sol.hotel ? [await render(hotelHtml(sol.hotel, sol.nights, sol.rooms, plan.hotelDistanceKm, now))] : [])],
    `🗺 <b>${e(plan.title)}</b> · ${e(dateRange(plan.trip.startDate, plan.trip.endDate))} · ≈ ${t.rupees(avg)} each`,
  );
  await milo.say(chatId, flightsText(plan));

  const dayPngs: Buffer[] = [];
  for (const [i, d] of plan.days.entries()) {
    const data = dayData(d, i, plan, now);
    dayPngs.push(await render(t.dayCard(data), () => t.dayCard(data, { withMap: false })));
  }
  await album(dayPngs, `📍 <b>Day by day</b> · each day stays in one area`);
  await milo.say(chatId, daysText(plan));

  await api.sendChatAction(chatId, "upload_photo").catch(() => {});
  const cost = await render(costHtml(sol.costs, s.squad, sol.nights, sol.rooms));
  await milo.send(chatId, () => api.sendPhoto(chatId, new InputFile(cost, "cost.png"), { caption: "💸 <b>Cost split</b> · flights + hotel share per person", parse_mode: "HTML" }));

  const plan2 = { startDate: plan.trip.startDate, endDate: plan.trip.endDate, flights: sol.flights, costs: sol.costs, hotel: sol.hotel, days: plan.days };
  const passes: Buffer[] = [];
  for (const [i, p] of s.squad.entries()) {
    const checks = checkPerson(plan2, p);
    passes.push(await render(passHtml(p, i, sol.flights.find((f) => f.person === p.name), sol.costs.find((c) => c.person === p.name), checks, plan.trip, sol.hotel?.name)));
  }
  await album(passes, `🎫 <b>Boarding passes</b> · why this plan works for each of you`);
  await milo.say(chatId, passText(plan, s.squad), new InlineKeyboard().text("See sources 🔎", "sources"));
}
