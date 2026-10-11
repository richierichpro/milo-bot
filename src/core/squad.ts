import type { Flight, FlightPick, Itinerary, Person } from "./types.js";

// ---- Every knob of the flight picker lives here. ----
/** ₹ for every 10 minutes between the first and last arrival (or return departure). */
export const SPREAD_PENALTY_PER_10_MIN = 300;
/** ₹ per person landing at (or leaving from) a different airport than most of the squad. Goa's GOI and GOX are 1.5–2 h apart. */
export const OTHER_AIRPORT_PENALTY = 4000;
/** ₹ per hour of travel beyond the fastest option on that person's route. */
export const EXTRA_HOUR_PENALTY = 250;
/** ₹ per stop. */
export const STOP_PENALTY = 1000;
/** Cheapest options kept per person and direction, on top of every nonstop. */
export const KEEP_CHEAPEST = 8;
/** Upper bound on combinations tried per direction. */
export const MAX_COMBOS = 50_000;

/** Every nonstop plus the cheapest few, deduped, cheapest first. */
export function selectFlightOptions(flights: Flight[]): Flight[] {
  const byPrice = [...flights].sort((a, b) => a.pricePerPerson - b.pricePerPerson);
  const keep = new Map<string, Flight>();
  for (const f of byPrice.slice(0, KEEP_CHEAPEST)) keep.set(f.id, f);
  for (const f of byPrice) if (f.stops === 0) keep.set(f.id, f);
  return [...keep.values()].sort((a, b) => a.pricePerPerson - b.pricePerPerson);
}

const minutes = (t: string) => Date.parse(`${t.replace(" ", "T")}:00Z`) / 60_000;

type Combo = { flights: Flight[]; price: number; spreadMin: number; score: number };

/** Price plus penalties for a slow or connecting flight, relative to the fastest on the route. */
function flightCost(f: Flight, fastestMin: number): number {
  return f.pricePerPerson + (Math.max(0, f.durationMin - fastestMin) / 60) * EXTRA_HOUR_PENALTY + f.stops * STOP_PENALTY;
}

/** Most common airport in the list. */
export function majorityAirport(codes: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Score every combination of one flight per person; return the best and the cheapest. */
function bestCombo(
  options: Flight[][],
  timeOf: (f: Flight) => string,
  airportOf: (f: Flight) => string,
): { best?: Combo; cheapest?: Combo } {
  if (!options.length || options.some((o) => !o.length)) return {};
  const scored = options.map((o) => {
    const fastest = Math.min(...o.map((f) => f.durationMin || Infinity));
    return o.map((f) => ({ f, cost: flightCost(f, Number.isFinite(fastest) ? fastest : f.durationMin) })).sort((a, b) => a.cost - b.cost);
  });
  // Keep each person's best-value options, shrinking until the product fits.
  let k = Math.max(...scored.map((o) => o.length));
  while (k > 1 && scored.reduce((n, o) => n * Math.min(o.length, k), 1) > MAX_COMBOS) k--;
  const lists = scored.map((o) => o.slice(0, k));

  let best: Combo | undefined;
  let cheapest: Combo | undefined;
  const idx = lists.map(() => 0);
  for (;;) {
    const picks = lists.map((l, i) => l[idx[i]]);
    const flights = picks.map((p) => p.f);
    const times = flights.map((f) => minutes(timeOf(f)));
    const spreadMin = Math.max(...times) - Math.min(...times);
    const price = flights.reduce((s, f) => s + f.pricePerPerson, 0);
    const airports = flights.map(airportOf);
    const major = majorityAirport(airports);
    const elsewhere = airports.filter((a) => a !== major).length;
    const score =
      picks.reduce((s, p) => s + p.cost, 0) + (spreadMin / 10) * SPREAD_PENALTY_PER_10_MIN + elsewhere * OTHER_AIRPORT_PENALTY;
    if (!best || score < best.score) best = { flights, price, spreadMin, score };
    if (!cheapest || price < cheapest.price) cheapest = { flights, price, spreadMin, score };
    // Next combination (odometer).
    let i = 0;
    while (i < idx.length && ++idx[i] === lists[i].length) idx[i++] = 0;
    if (i === idx.length) break;
  }
  return { best, cheapest };
}

export type SquadFlights = Pick<Itinerary, "flights" | "arrivalWindow"> & {
  departureWindow?: { first: string; last: string };
  cheapestTotal: number;
  bestTotal: number;
};

/**
 * "Land together": the flights for everyone that keep arrivals (and return
 * departures) close while staying cheap.
 */
export function pickSquadFlights(
  flightsOut: Record<string, Flight[]>,
  flightsBack: Record<string, Flight[]>,
  squad: Person[],
  opts: { priceFirst?: string[]; keep?: FlightPick[] } = {},
): SquadFlights {
  // People who asked for price first get their cheapest flight. Anyone in `keep`
  // stays on the flights they already have.
  const priceFirst = new Set(opts.priceFirst ?? []);
  const kept = new Map((opts.keep ?? []).map((k) => [k.person, k]));
  const restrict = (fs: Flight[] | undefined, name: string, current?: Flight) => {
    if (priceFirst.has(name) && fs?.length) return [[...fs].sort((a, b) => a.pricePerPerson - b.pricePerPerson)[0]];
    if (current) return [current];
    return fs ?? [];
  };
  flightsOut = Object.fromEntries(squad.map((p) => [p.name, restrict(flightsOut[p.name], p.name, kept.get(p.name)?.out)]));
  flightsBack = Object.fromEntries(squad.map((p) => [p.name, restrict(flightsBack[p.name], p.name, kept.get(p.name)?.back)]));
  // Anyone whose search failed is left out of the optimisation (their card says "couldn't check this").
  const withOut = squad.filter((p) => flightsOut[p.name]?.length);
  const withBack = squad.filter((p) => flightsBack[p.name]?.length);
  const out = bestCombo(withOut.map((p) => flightsOut[p.name]), (f) => f.arriveTime, (f) => f.to);
  const back = bestCombo(withBack.map((p) => flightsBack[p.name]), (f) => f.departTime, (f) => f.from);
  const pickFor = (people: Person[], combo: Combo | undefined, name: string) => combo?.flights[people.findIndex((p) => p.name === name)];

  const flights: FlightPick[] = squad.map((p) => ({
    person: p.name,
    city: p.city,
    out: pickFor(withOut, out.best, p.name),
    back: pickFor(withBack, back.best, p.name),
  }));
  const bestTotal = (out.best?.price ?? 0) + (back.best?.price ?? 0);
  const cheapestTotal = (out.cheapest?.price ?? 0) + (back.cheapest?.price ?? 0);
  const window = (fs: Flight[] | undefined, timeOf: (f: Flight) => string) => {
    if (!fs?.length) return undefined;
    const ts = fs.map(timeOf).sort();
    return { first: ts[0], last: ts[ts.length - 1] };
  };
  const arr = window(out.best?.flights, (f) => f.arriveTime);

  return {
    flights,
    arrivalWindow: arr ? { ...arr, extraVsCheapest: bestTotal - cheapestTotal } : undefined,
    departureWindow: window(back.best?.flights, (f) => f.departTime),
    cheapestTotal,
    bestTotal,
  };
}

/** "Kabir lands at GOI, ~1.5 h from the others at GOX", or undefined when everyone shares an airport. */
export function airportSplitNote(flights: FlightPick[], direction: "out" | "back"): string | undefined {
  const legs = flights
    .map((f) => ({ person: f.person, code: direction === "out" ? f.out?.to : f.back?.from }))
    .filter((x): x is { person: string; code: string } => !!x.code);
  const major = majorityAirport(legs.map((l) => l.code));
  const odd = legs.filter((l) => l.code !== major);
  if (!odd.length || !major) return undefined;
  const verb = direction === "out" ? "lands at" : "flies home from";
  const goaPair = (a: string) => [a, major].sort().join() === "GOI,GOX";
  return (
    odd.map((o) => (goaPair(o.code) ? `${o.person} ${verb} ${o.code}, ~1.5 h from the others at ${major}` : `${o.person} ${verb} ${o.code}, not ${major} like the others`)).join("; ") + "."
  );
}
