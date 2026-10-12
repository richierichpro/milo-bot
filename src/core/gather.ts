/* eslint-disable @typescript-eslint/no-explicit-any -- raw SerpApi JSON is parsed here */
import { resolveAirport } from "./airports.js";
import { checkEvents, checkPlaces } from "./checks.js";
import { normalizeFlights, normalizeHotels, normalizePlaces } from "./normalize.js";
import * as q from "./queries.js";
import { serpSearch, type SerpParams } from "./serpapi.js";
import { selectFlightOptions } from "./squad.js";
import { capActivities } from "./themes.js";
import type { CallLogEntry, Constraint, Drop, Event, Flight, Hotel, Place, SquadMember } from "./types.js";

export type Trip = { destination: string; startDate: string; endDate: string; interests: string[] };

export type CandidatePool = {
  flightsOut: Record<string, Flight[]>;
  flightsBack: Record<string, Flight[]>;
  hotels: Hotel[];
  places: Place[];
  events: Event[];
  receipts: CallLogEntry[];
  errors: string[];
  drops: Drop[];
};

const KEEP = { hotels: 12, placesPerQuery: 10, perSightQuery: 16, perInterest: 4, events: 8, interests: 3, activityShops: 3 };

/** Share of the tightest per-person budget we allow for the stay when capping hotel prices. */
export const HOTEL_BUDGET_SHARE = 0.5;
const PEOPLE_PER_ROOM = 2;

type FlightLimit = Extract<Constraint, { kind: "flight_time" }>;

/** A person's hard departure window for one leg, as Google Flights' outbound_times ("8,23"). */
export function outboundTimes(person: SquadMember, direction: "out" | "back", date: string): string | undefined {
  const limits = person.constraints.filter(
    (c): c is FlightLimit =>
      c.kind === "flight_time" && c.hard && !c.waived && (c.direction === "any" || c.direction === direction) && (!c.date || c.date === date),
  );
  if (!limits.length) return undefined;
  const hour = (t: string) => Number(t.split(":")[0]);
  const from = Math.max(0, ...limits.map((c) => (c.notBefore ? hour(c.notBefore) : 0)));
  const to = Math.min(23, ...limits.map((c) => (c.notAfter ? Math.max(0, hour(c.notAfter) - 1) : 23)));
  return from > 0 || to < 23 ? `${from},${Math.max(from, to)}` : undefined;
}

export function tightestBudget(squad: SquadMember[]): number | undefined {
  const caps = squad.flatMap((p) => p.constraints.flatMap((c) => (c.kind === "budget" && c.hard && !c.waived ? [c.max] : [])));
  return caps.length ? Math.min(...caps) : undefined;
}

const nights = (t: Trip) => Math.max(1, Math.round((Date.parse(t.endDate) - Date.parse(t.startDate)) / 86_400_000));

/** Rough per-room nightly cap from the tightest budget (two people share a room). */
export function hotelPriceCap(squad: SquadMember[], trip: Trip): number | undefined {
  const budget = tightestBudget(squad);
  return budget ? Math.round((budget * HOTEL_BUDGET_SHARE * PEOPLE_PER_ROOM) / nights(trip) / 100) * 100 : undefined;
}

const FOOD_QUERY: Record<string, string> = {
  veg: "vegetarian restaurants",
  vegan: "vegan restaurants",
  jain: "jain food restaurants",
};

/** Every search for a trip, in parallel, shaped by everyone's limits. A failed search is recorded and the rest carry on. */
export async function gatherCandidates(trip: Trip, squad: SquadMember[], onProgress?: (text: string) => void): Promise<CandidatePool> {
  const receipts: CallLogEntry[] = [];
  const errors: string[] = [];
  const dest = trip.destination.trim();
  const destAirport = resolveAirport(dest);
  if (!destAirport) throw new Error(`I don't know the airport for "${dest}" yet.`);

  const run = async <T>(label: string, params: SerpParams, parse: (json: any) => T, empty: T): Promise<T> => {
    onProgress?.(`Searching ${label}…`);
    try {
      return parse(await serpSearch(params, { log: receipts }));
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message}`);
      return empty;
    }
  };

  // One flight search per distinct (route, date, time window); friends from the same city with the same limits share it.
  const searches = new Map<string, Promise<Flight[]>>();
  const shared = (from: string, to: string, date: string, times?: string) => {
    const key = `${from}|${to}|${date}|${times ?? ""}`;
    if (!searches.has(key)) {
      const label = `Google Flights ${from} → ${to}${times ? ` (departs ${times.replace(",", "–")}h)` : ""}`;
      searches.set(key, run(label, q.flightParams(from, to, date, { outboundTimes: times }), (j) => selectFlightOptions(normalizeFlights(j)), [] as Flight[]));
    }
    return searches.get(key)!;
  };

  const flightsOut: Record<string, Promise<Flight[]>> = {};
  const flightsBack: Record<string, Promise<Flight[]>> = {};
  for (const p of squad) {
    const home = p.city ? resolveAirport(p.city) : null;
    if (!home) {
      errors.push(`No airport known for ${p.name}'s city "${p.city ?? "?"}"`);
      continue;
    }
    flightsOut[p.name] = shared(home.codes, destAirport.codes, trip.startDate, outboundTimes(p, "out", trip.startDate));
    flightsBack[p.name] = shared(destAirport.codes, home.codes, trip.endDate, outboundTimes(p, "back", trip.endDate));
  }

  const cap = hotelPriceCap(squad, trip);
  const diets = [...new Set(squad.flatMap((p) => p.constraints.flatMap((c) => (c.kind === "food" && c.hard ? [c.diet] : []))))];
  // Only must-dos that name a place ("Chapora fort") get their own search; "a proper beach day" doesn't.
  const mustDos = squad.flatMap((p) => p.constraints.flatMap((c) => (c.kind === "must_do" && /[A-Z]/.test(c.what) ? [c.what] : [])));
  // Sights first, from four angles (famous, popular, offbeat, historic): preferences are added to the trip, they aren't the whole trip.
  // "hidden gems in X" returns nothing on Maps and "adventure activities" is all water-sports shops, so neither is used.
  const sightQueries = [`top attractions in ${dest}`, `things to do in ${dest}`, `offbeat places to visit in ${dest}`, `historical places in ${dest}`];
  const interestQueries = trip.interests.slice(0, KEEP.interests).map((i) => `best ${i} in ${dest}`);
  const mapsQueries = [
    ...sightQueries,
    `best restaurants in ${dest}`,
    ...interestQueries,
    ...diets.filter((d) => FOOD_QUERY[d]).map((d) => `${FOOD_QUERY[d]} in ${dest}`),
    ...mustDos.map((m) => (m.toLowerCase().includes(dest.toLowerCase()) ? m : `${m} ${dest}`)),
  ];

  // No events search: Google mostly lists the next few weeks, rarely the trip dates. Activities come from Maps instead.
  const [hotels, placeLists] = await Promise.all([
    run(
      `Google Hotels · hotels in ${dest}${cap ? ` under ₹${cap}/night` : ""}`,
      q.hotelParams(dest, trip.startDate, trip.endDate, { maxPrice: cap }),
      (j) => normalizeHotels(j).filter((h) => h.pricePerNight !== undefined).slice(0, KEEP.hotels),
      [] as Hotel[],
    ),
    Promise.all(
      [...new Set(mapsQueries)].map((query) =>
        // An interest ("cruise") gets a few picks, not a dozen operators.
        run(`Google Maps · ${query}`, q.mapsParams(query), (j) => normalizePlaces(j).slice(0, interestQueries.includes(query) ? KEEP.perInterest : sightQueries.includes(query) ? KEEP.perSightQuery : KEEP.placesPerQuery), [] as Place[]),
      ),
    ),
  ]);

  const mustMatch = (p: Place) => mustDos.some((m) => p.name.toLowerCase().includes(m.toLowerCase()));
  const places = checkPlaces(capActivities([...new Map(placeLists.flat().map((p) => [p.id, p])).values()], KEEP.activityShops, mustMatch));
  const events = checkEvents([], trip);

  const resolved = async (m: Record<string, Promise<Flight[]>>) =>
    Object.fromEntries(await Promise.all(Object.entries(m).map(async ([k, v]) => [k, await v] as const)));

  return {
    flightsOut: await resolved(flightsOut),
    flightsBack: await resolved(flightsBack),
    hotels,
    places: places.kept,
    events: events.kept.slice(0, KEEP.events),
    receipts,
    errors,
    drops: [...places.drops, ...events.drops],
  };
}
