import * as SunCalc from "suncalc";
import { airportCoords } from "./airports.js";
import { isOpenAt } from "./checks.js";
import { callTool, type ToolDef } from "./claude.js";
import { checkPerson, suitsDiet, type ConstraintCheck } from "./constraints.js";
import { DirectionsBudget, getTravelTime, type LatLng } from "./directions.js";
import type { CandidatePool, Trip } from "./gather.js";
import { haversineKm, median } from "./geo.js";
import type { Solution } from "./solve.js";
import type { CallLogEntry, Day, Drop, Event, Logistics, Place, SquadMember, Stop } from "./types.js";

// Claude arranges real candidates by id; code checks everything it returns and
// adds the logistics (transfers, leave-by times, hop times, sunset).

export type DraftStop = { id: string; time: string; note: string };
export type Draft = { title: string; summary: string; days: { date: string; title: string; stops: DraftStop[] }[] };

export type TripPlan = {
  title: string;
  summary: string;
  trip: Trip;
  solution: Solution;
  days: Day[];
  hotelDistanceKm?: number;
  verification: { total: number; verified: number; removed: string[] };
  drops: Drop[];
  checks: Record<string, ConstraintCheck[]>;
  receipts: CallLogEntry[];
  createdAt: string;
};

export const MAX_STOPS_FULL_DAY = 5;
/** Sights or activities ([do]) every full day needs, so a day isn't only meals and bars. */
export const MIN_DO_FULL_DAY = 2;
export const SHORT_HOP_KM = 3;
export const HOTEL_FAR_KM = 10;
/** A day whose places are further apart than this isn't "one area". */
export const DAY_SPREAD_KM = 12;
/** Leave for the airport this long before departure, plus the transfer time. */
export const AIRPORT_BUFFER_MIN = 120;
const IST = 330; // minutes ahead of UTC

const SUBMIT: ToolDef = {
  name: "submit_itinerary",
  description: "Submit the day-by-day plan. Every stop id must be copied from the candidate list.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary", "days"],
    properties: {
      title: { type: "string", description: "Short trip title, no numbers" },
      summary: { type: "string", description: "Two sentences, no prices, ratings or numbers" },
      days: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["date", "title", "stops"],
          properties: {
            date: { type: "string" },
            title: { type: "string", description: "A few words naming the area or theme" },
            stops: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "time", "note"],
                properties: {
                  id: { type: "string" },
                  time: { type: "string", description: "HH:MM 24h" },
                  note: { type: "string", description: "At most 15 words, using only facts from this candidate's own line" },
                },
              },
            },
          },
        },
      },
    },
  },
};

const RENOTE: ToolDef = {
  name: "rewrite_notes",
  description: "Rewrite these notes using only facts from each candidate's line.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["notes"],
    properties: { notes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "note"], properties: { id: { type: "string" }, note: { type: "string" } } } } },
  },
};

const SYSTEM = `You arrange a friend group's trip like a careful local planner, using ONLY the numbered candidates given. You never invent places, events, prices, ratings, hours or facts.
Rules:
- Copy ids exactly (p12, e1). Use each place at most once.
- At most ${MAX_STOPS_FULL_DAY} stops on a full day; light arrival and departure days. Nothing before the squad is together on the first day or after they leave for the airport on the last day.
- Keep each day in one area (use the @lat,lng). Meals at meal times (lunch 12:30–14:30, dinner 19:30–22:00). A beach or viewpoint near sunset. Respect opening hours shown.
- On beach trips leave a free afternoon block on one day; after a late night, start the next day late.
- Each place is tagged [do] (sights, nature, culture, activities), [eat] or [night]. Build every full day around at least ${MIN_DO_FULL_DAY} [do] stops: the destination's highlights plus a lesser-known gem (high rating, fewer reviews). Then at most 2 [eat] and 1 [night] per day.
- The group's interests, must-dos and preferences must be in the trip, but they aren't the whole trip.
- If anyone is veg/jain, every full day needs at least one meal stop from the places marked [veg]. Include every must-do that is in the list.
- Notes: at most 15 words, only facts present in that candidate's line (its category, description, rating words). No superlatives that aren't in its line (no "famous", "iconic", "best"), no numbers, no other place names. Describe events exactly as titled; a tribute or candlelight concert is never the artist performing.
- Titles and the summary: no prices, ratings or numbers.`;

// ---------- Candidate lines ----------

export const alias = { place: (i: number) => `p${i + 1}`, event: (i: number) => `e${i + 1}` };
const WEEKDAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const weekday = (date: string) => WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];

/** What a place is for: something to see or do, a meal, or a night out. */
export function placeKind(p: Pick<Place, "category">): "do" | "eat" | "night" {
  const c = (p.category ?? "").toLowerCase();
  if (/night ?club|disco|pub\b|lounge|\bbar\b|cocktail|brewery|casino/.test(c)) return "night";
  if (/restaurant|cafe|café|coffee|bistro|bakery|dhaba|eatery|food|shack|diner|sweet|kitchen|grill|pizza|bar & grill/.test(c)) return "eat";
  return "do";
}

function placeLine(p: Place, i: number, dates: string[], vegOk: boolean): string {
  const hours = [...new Set(dates.map((d) => p.operatingHours?.[weekday(d)]).filter(Boolean))].join(" / ") || "hours not listed";
  return [alias.place(i), p.name, p.category ?? "place", p.rating ? `${p.rating}★ (${p.reviews ?? 0})` : "no rating", p.priceLevel ?? "-", p.description ?? "-", hours, `@${p.lat.toFixed(3)},${p.lng.toFixed(3)}`, `[${placeKind(p)}]`, vegOk ? "[veg]" : ""]
    .filter(Boolean)
    .join(" | ");
}
const eventLine = (e: Event, i: number) => [alias.event(i), e.title, `on ${e.date}`, e.venue ?? "-", e.address ?? "-"].join(" | ");

export function tripDates(t: Pick<Trip, "startDate" | "endDate">): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${t.startDate}T00:00:00Z`); d <= Date.parse(`${t.endDate}T00:00:00Z`); d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

const hm = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`;
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const clock = (t: string) => t.slice(11, 16);

export function sunsetAt(date: string, at: LatLng): string {
  const t = SunCalc.getTimes(new Date(`${date}T06:30:00Z`), at.lat, at.lng).sunset;
  return t ? hm(t.getUTCHours() * 60 + t.getUTCMinutes() + IST) : "18:00";
}

/** When the squad is together on day 1 and must leave for the airport on the last day (before transfers). */
function window(sol: Solution) {
  const arrivals = sol.flights.map((f) => f.out?.arriveTime).filter((x): x is string => !!x).sort();
  const departures = sol.flights.map((f) => f.back?.departTime).filter((x): x is string => !!x).sort();
  return { lastArrival: arrivals.at(-1), firstDeparture: departures[0] };
}

function prompt(pool: CandidatePool, trip: Trip, sol: Solution, squad: SquadMember[], transferIn?: number, transferOut?: number): string {
  const dates = tripDates(trip);
  const vegNeeded = squad.some((p) => p.constraints.some((c) => c.kind === "food" && (c.diet === "veg" || c.diet === "jain")));
  const w = window(sol);
  const freeFrom = w.lastArrival ? hm(toMin(clock(w.lastArrival)) + (transferIn ?? 60) + 30) : "?";
  const leaveBy = w.firstDeparture ? hm(toMin(clock(w.firstDeparture)) - AIRPORT_BUFFER_MIN - (transferOut ?? 60)) : "?";
  const hotel = sol.hotel;
  const mustDos = squad.flatMap((p) => p.constraints.flatMap((c) => (c.kind === "must_do" ? [`${p.name}: ${c.what}`] : [])));
  const vibes = squad.flatMap((p) => p.constraints.flatMap((c) => (c.kind === "vibe" || c.kind === "no_go" ? [`${p.name}: ${c.kind === "no_go" ? "avoid " : ""}${c.what}`] : [])));
  const events = pool.events.map((e, i) => ({ e, i }));
  return [
    `Trip: ${squad.length} friends to ${trip.destination}, ${trip.startDate} to ${trip.endDate}. Days: ${dates.join(", ")}.`,
    `Interests: ${trip.interests.join(", ") || "anything"}. ${vegNeeded ? "Someone is vegetarian: a [veg] meal stop every full day." : ""}`,
    mustDos.length ? `Must-dos: ${mustDos.join("; ")}.` : "",
    vibes.length ? `Preferences: ${vibes.join("; ")}.` : "",
    `Day 1: squad together from ${freeFrom} (last lands ${w.lastArrival ? clock(w.lastArrival) : "?"}). Last day: leave for the airport by ${leaveBy}.`,
    `Sunset: ${dates.map((d) => `${d} ${sunsetAt(d, hotel ?? pool.places[0])}`).join(", ")}.`,
    hotel ? `Hotel (fixed): ${hotel.name} @${hotel.lat.toFixed(3)},${hotel.lng.toFixed(3)}. Prefer places near it.` : "",
    "",
    "PLACES (id | name | category | rating | price | description | hours on trip days | location | kind | diet):",
    ...pool.places.map((p, i) => placeLine(p, i, dates, vegNeeded && suitsDiet(p, "veg"))),
    "",
    events.length ? "EVENTS (id | title | date | venue | address):" : "EVENTS: none on these dates.",
    ...events.map(({ e, i }) => eventLine(e, i)),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ---------- Note check ----------

const BANNED = /\b(famous|iconic|legendary|best|big-name|world-class|must-visit|favourite|favorite|top|renowned|hidden gem|popular)\b/i;
const EVERYDAY = new Set(["A", "An", "The", "Great", "Good", "Easy", "Relaxed", "Quiet", "Local", "Classic", "Sunset", "Morning", "Evening", "Lunch", "Dinner", "Breakfast", "Brunch", "Beach", "Fort", "Cafe", "Café", "Veg", "Vegetarian", "Pure", "Seafood", "Goan", "Indian", "Sea", "Views", "View"]);

/** A note may only use facts in the candidate's own data: no new numbers, names or superlatives. */
export function noteProblem(note: string, item: Place | Event, allowNames: string[] = []): string | undefined {
  if (!note.trim()) return undefined;
  const own = ("name" in item ? `${item.name} ${item.category ?? ""} ${item.description ?? ""} ${item.address ?? ""} ${item.priceLevel ?? ""}` : `${item.title} ${item.venue ?? ""} ${item.address ?? ""}`).toLowerCase();
  for (const n of note.match(/\d[\d,.]*/g) ?? []) if (!own.includes(n)) return `number "${n}" isn't in its data`;
  if (/[₹★]/.test(note)) return "prices or ratings belong on the card, not in the note";
  const sup = note.match(BANNED)?.[0];
  if (sup && !own.includes(sup.toLowerCase())) return `"${sup}" isn't in its data`;
  const words = note.replace(/^[^A-Za-z]*/, "").split(/[\s,;:.!?()]+/).slice(1);
  for (const w of words) {
    const clean = w.replace(/['’]s$/, "");
    if (!/^[A-Z][a-z]/.test(clean) || EVERYDAY.has(clean)) continue;
    if (!own.includes(clean.toLowerCase()) && !allowNames.some((a) => a.toLowerCase() === clean.toLowerCase())) return `"${clean}" isn't in its data`;
  }
  if (!("name" in item) && /tribute|candlelight|cover/i.test(item.title) && /\b(live|performs?|performing|playing|plays)\b/i.test(note)) return "a tribute concert isn't the artist performing";
  return undefined;
}

// ---------- Plan ----------

export async function planTrip(
  pool: CandidatePool,
  trip: Trip,
  sol: Solution,
  squad: SquadMember[],
  opts: { log?: CallLogEntry[]; onProgress?: (text: string) => void } = {},
): Promise<TripPlan> {
  const log = opts.log ?? [];
  const budget = new DirectionsBudget(12);
  const dates = tripDates(trip);
  const hotel = sol.hotel;

  // Transfers first: they decide when day 1 can start and when the last day ends.
  opts.onProgress?.("Checking airport transfer times…");
  const arrivalAirports = [...new Set(sol.flights.map((f) => f.out?.to).filter((x): x is string => !!x))];
  const departureAirports = [...new Set(sol.flights.map((f) => f.back?.from).filter((x): x is string => !!x))];
  const transferIn: Record<string, number> = {};
  const transferOut: Record<string, number> = {};
  if (hotel) {
    for (const code of arrivalAirports) {
      const c = airportCoords(code);
      const t = c && (await getTravelTime({ lat: c[0], lng: c[1] }, hotel, "driving", undefined, { budget, log }).catch(() => undefined));
      if (t) transferIn[code] = t.minutes;
    }
    for (const code of departureAirports) {
      const c = airportCoords(code);
      const t = c && (await getTravelTime(hotel, { lat: c[0], lng: c[1] }, "driving", undefined, { budget, log }).catch(() => undefined));
      if (t) transferOut[code] = t.minutes;
    }
  }
  const maxIn = Math.max(0, ...Object.values(transferIn));
  const maxOut = Math.max(0, ...Object.values(transferOut));

  opts.onProgress?.("Asking Claude to arrange the days…");
  const base = prompt(pool, trip, sol, squad, maxIn || undefined, maxOut || undefined);
  let draft = await callTool<Draft>(SYSTEM, [{ role: "user", content: base }], SUBMIT);

  // Grounding, hours and food checks; one chance to fix.
  opts.onProgress?.("Checking every item against search results…");
  const lookup = new Map<string, Place | Event>([...pool.places.map((p, i) => [alias.place(i), p] as const), ...pool.events.map((e, i) => [alias.event(i), e] as const)]);
  const problemsOf = (d: Draft) => {
    const out: string[] = [];
    const unknown = d.days.flatMap((day) => day.stops.filter((s) => !lookup.has(s.id)).map((s) => s.id));
    if (unknown.length) out.push(`These ids aren't in the list: ${unknown.join(", ")}.`);
    const vegNeeded = squad.some((p) => p.constraints.some((c) => c.kind === "food" && (c.diet === "veg" || c.diet === "jain")));
    if (vegNeeded)
      d.days.forEach((day, i) => {
        const full = i > 0 && i < d.days.length - 1;
        if (full && !day.stops.some((s) => { const p = lookup.get(s.id); return p && "name" in p && suitsDiet(p, "veg"); })) out.push(`${day.date} needs a [veg] meal stop.`);
      });
    for (const p of squad)
      for (const c of p.constraints)
        if (c.kind === "must_do" && /[A-Z]/.test(c.what) && [...lookup.values()].some((x) => "name" in x && x.name.toLowerCase().includes(c.what.toLowerCase())) && !d.days.some((day) => day.stops.some((s) => { const x = lookup.get(s.id); return x && "name" in x && x.name.toLowerCase().includes(c.what.toLowerCase()); })))
          out.push(`Include ${p.name}'s must-do ${c.what}.`);
    const doAvailable = pool.places.filter((p) => placeKind(p) === "do").length;
    d.days.forEach((day, i) => {
      const full = i > 0 && i < d.days.length - 1;
      const dos = day.stops.filter((s) => { const p = lookup.get(s.id); return !!p && ("title" in p || placeKind(p) === "do"); }).length;
      if (full && doAvailable >= MIN_DO_FULL_DAY * (d.days.length - 2) && dos < MIN_DO_FULL_DAY) out.push(`${day.date} has only ${dos} [do] stop${dos === 1 ? "" : "s"}; add sights or activities (at least ${MIN_DO_FULL_DAY}).`);
    });
    d.days.forEach((day) => {
      const pts = day.stops.map((s) => lookup.get(s.id)).filter((x): x is Place => !!x && "lat" in x);
      let spread = 0;
      for (const a of pts) for (const b of pts) spread = Math.max(spread, haversineKm(a, b));
      if (spread > DAY_SPREAD_KM) out.push(`${day.date}: stops are up to ${Math.round(spread)} km apart; keep the day within one area.`);
    });
    if (hotel) {
      const pts = d.days.flatMap((day) => day.stops.map((s) => lookup.get(s.id)).filter((x): x is Place => !!x && "lat" in x));
      const typical = median(pts.map((x) => haversineKm(hotel, x)));
      if (typical && typical > HOTEL_FAR_KM) out.push(`Most stops are about ${Math.round(typical)} km from the hotel; choose places closer to it.`);
    }
    return out;
  };
  const first = problemsOf(draft);
  if (first.length) {
    draft = await callTool<Draft>(SYSTEM, [{ role: "user", content: `${base}\n\nYour previous plan:\n${JSON.stringify(draft)}\n\nFix only these problems and resubmit the full plan:\n- ${first.join("\n- ")}` }], SUBMIT);
  }

  // Build the days; drop anything that still fails, with a reason.
  const drops: Drop[] = [];
  const removed: string[] = [];
  const seen = new Set<string>();
  const names = [trip.destination, ...squad.map((p) => p.name)];
  const days: Day[] = dates.map((date) => {
    const d = draft.days.find((x) => x.date === date);
    const stops: Stop[] = [];
    for (const s of d?.stops ?? []) {
      const item = lookup.get(s.id);
      if (!item) {
        removed.push(s.id);
        continue;
      }
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const time = /^\d{1,2}:\d{2}$/.test(s.time) ? s.time.padStart(5, "0") : "12:00";
      if ("name" in item) {
        const open = isOpenAt(item, date, time);
        if (open === false) {
          drops.push({ id: item.id, name: item.name, kind: "place", reason: `closed at ${time} on ${weekday(date)}` });
          continue;
        }
        stops.push({ kind: "place", item, time, why: s.note.trim(), hoursNote: open === undefined ? "hours not listed" : undefined });
      } else stops.push({ kind: "event", item, time, why: s.note.trim() });
    }
    stops.sort((a, b) => a.time.localeCompare(b.time));
    return { date, title: d?.title ?? "Free day", stops };
  });

  // Note check: rewrite failing notes once, then show no note.
  const bad = days.flatMap((d) => d.stops.filter((s) => noteProblem(s.why, s.item, names)));
  if (bad.length) {
    const lines = bad.map((s) => {
      const i = s.kind === "place" ? pool.places.indexOf(s.item) : pool.events.indexOf(s.item);
      return `${s.kind === "place" ? placeLine(s.item, i, dates, false) : eventLine(s.item, i)}  ← old note: "${s.why}" (${noteProblem(s.why, s.item, names)})`;
    });
    try {
      const r = await callTool<{ notes: { id: string; note: string }[] }>(SYSTEM, [{ role: "user", content: `Rewrite each note (max 15 words) using only facts in its own line:\n${lines.join("\n")}` }], RENOTE, { maxTokens: 1500 });
      for (const s of bad) {
        const key = s.kind === "place" ? alias.place(pool.places.indexOf(s.item)) : alias.event(pool.events.indexOf(s.item));
        const fresh = r.notes.find((n) => n.id === key)?.note ?? "";
        s.why = noteProblem(fresh, s.item, names) ? "" : fresh;
      }
    } catch {
      for (const s of bad) s.why = "";
    }
  }

  // Logistics: arrivals, check-in, hops, leave-by, sunset, airport run.
  opts.onProgress?.("Working out travel times between stops…");
  const w = window(sol);
  for (const [i, day] of days.entries()) {
    const logistics: Logistics[] = [];
    if (i === 0 && hotel) {
      for (const code of arrivalAirports) {
        const who = sol.flights.filter((f) => f.out?.to === code);
        const last = who.map((f) => f.out!.arriveTime).sort().at(-1)!;
        logistics.push({ time: clock(last), label: `${who.map((f) => f.person).join(", ")} land at ${code}${transferIn[code] ? ` · ${transferIn[code]} min to the hotel (Google Maps)` : ""}`, at: "start" });
      }
      const firstIn = w.lastArrival && hotel.checkInTime ? `Check-in from ${hotel.checkInTime}` : undefined;
      if (firstIn) logistics.push({ time: hm(toMin(clock(w.lastArrival!)) + maxIn), label: `At ${hotel.name} · ${firstIn}`, at: "start" });
    }
    if (i === days.length - 1 && w.firstDeparture) {
      const leave = hm(toMin(clock(w.firstDeparture)) - AIRPORT_BUFFER_MIN - maxOut);
      logistics.push({ time: leave, label: `Leave for the airport${maxOut ? ` (${maxOut} min drive, Google Maps)` : ""}${hotel?.checkOutTime ? ` · check-out by ${hotel.checkOutTime}` : ""}`, at: "end" });
    }
    let prev: LatLng | undefined = hotel;
    let travel = 0;
    for (const s of day.stops) {
      if (s.kind !== "place") continue;
      if (prev) {
        const km = haversineKm(prev, s.item);
        if (km > SHORT_HOP_KM) {
          const mode = squad.some((p) => p.constraints.some((c) => c.kind === "vibe" && /scooter|bike/i.test(c.what))) ? "two_wheeler" : "driving";
          const t = await getTravelTime(prev, s.item, mode, undefined, { budget, log }).catch(() => undefined);
          if (t) {
            s.hop = `${t.text} by ${mode === "two_wheeler" ? "scooter" : "car"} (Google Maps)`;
            s.hopMinutes = t.minutes;
          } else {
            s.hop = `≈ ${Math.round(km)} km`;
            s.hopMinutes = Math.round((km * 1.3 * 60) / 30);
          }
        } else {
          s.hop = `≈ ${km < 1 ? "<1" : Math.round(km)} km, short ride`;
          s.hopMinutes = Math.round((km * 1.3 * 60) / 25);
        }
        travel += s.hopMinutes ?? 0;
      }
      prev = s.item;
    }
    const firstPlace = day.stops.find((s) => s.kind === "place");
    day.logistics = logistics;
    day.travelMinutes = travel;
    day.leaveBy = firstPlace && i > 0 ? hm(toMin(firstPlace.time) - (firstPlace.hopMinutes ?? 15)) : undefined;
    day.sunset = sunsetAt(day.date, hotel ?? pool.places[0]);
  }

  const stops = days.flatMap((d) => d.stops);
  const allFlights = [...Object.values(pool.flightsOut).flat(), ...Object.values(pool.flightsBack).flat()];
  const picked = sol.flights.flatMap((f) => [f.out, f.back]).filter((x) => !!x);
  const total = picked.length + (hotel ? 1 : 0) + stops.length;
  const verified =
    picked.filter((f) => allFlights.some((x) => x.id === f!.id)).length +
    (hotel && pool.hotels.some((h) => h.id === hotel.id) ? 1 : 0) +
    stops.filter((s) => [...pool.places, ...pool.events].some((x) => x.id === s.item.id)).length;

  const plan = { startDate: trip.startDate, endDate: trip.endDate, flights: sol.flights, costs: sol.costs, hotel, days };
  return {
    title: /\d/.test(draft.title) ? `${trip.destination} with the squad` : draft.title,
    summary: draft.summary.replace(/\s+/g, " ").trim(),
    trip,
    solution: sol,
    days,
    hotelDistanceKm: hotel ? median(stops.filter((s) => s.kind === "place").map((s) => haversineKm(hotel, s.item as Place))) : undefined,
    verification: { total, verified, removed },
    drops: [...pool.drops, ...drops],
    checks: Object.fromEntries(squad.map((p) => [p.id, checkPerson(plan, p)])),
    receipts: [...pool.receipts, ...log],
    createdAt: new Date().toISOString(),
  };
}
