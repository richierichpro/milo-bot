import { checkPerson, failingHard, type ConstraintCheck } from "./constraints.js";
import type { CandidatePool, Trip } from "./gather.js";
import { centreOf, haversineKm } from "./geo.js";
import { costSplit, formatINR, nightsBetween, roomsFor } from "./money.js";
import { pickSquadFlights, type SquadFlights } from "./squad.js";
import type { CostLine, FlightPick, Hotel, SquadMember } from "./types.js";

// Solving within everyone's limits: flights that respect hard time limits and land
// together, a hotel near the action, then every hard limit checked for every person.
// When a limit can't be met, real alternatives are priced for the person affected.

/** ₹ per km a hotel sits away from the centre of the plan's places, when choosing one. */
export const HOTEL_KM_PENALTY = 150;
/** Prefer hotels within this distance of the centre (CLAUDE.md: ~5 km). */
export const HOTEL_NEAR_KM = 5;

export type Solution = {
  flights: FlightPick[];
  arrivalWindow?: SquadFlights["arrivalWindow"];
  extraVsCheapest?: number;
  hotel?: Hotel;
  nights: number;
  rooms: number;
  costs: CostLine[];
  /** People who chose cheapest flights over landing together. */
  priceFirst: string[];
  checks: Record<string, ConstraintCheck[]>;
};

/** Cheap and close: price per night plus a penalty for distance from the places. */
export function chooseHotel(pool: CandidatePool, opts: { cheapest?: boolean } = {}): Hotel | undefined {
  const centre = centreOf(pool.places);
  const priced = pool.hotels.filter((h) => h.pricePerNight);
  if (opts.cheapest) return [...priced].sort((a, b) => a.pricePerNight! - b.pricePerNight!)[0];
  const score = (h: Hotel) => h.pricePerNight! + (centre ? Math.max(0, haversineKm(h, centre) - HOTEL_NEAR_KM) * HOTEL_KM_PENALTY * 10 : 0) - (h.rating ?? 0) * 200;
  return [...priced].sort((a, b) => score(a) - score(b))[0];
}

export function solve(pool: CandidatePool, trip: Trip, squad: SquadMember[], opts: { hotel?: Hotel; priceFirst?: string[] } = {}): Solution {
  const priceFirst = opts.priceFirst ?? [];
  const picked = pickSquadFlights(pool.flightsOut, pool.flightsBack, squad, { priceFirst });
  const hotel = opts.hotel ?? chooseHotel(pool);
  const nights = nightsBetween(trip.startDate, trip.endDate);
  const costs = costSplit(picked.flights, hotel, nights);
  const plan = { startDate: trip.startDate, endDate: trip.endDate, flights: picked.flights, costs, hotel };
  return {
    flights: picked.flights,
    arrivalWindow: picked.arrivalWindow,
    extraVsCheapest: picked.arrivalWindow?.extraVsCheapest,
    hotel,
    nights,
    rooms: roomsFor(squad.length),
    costs,
    priceFirst,
    checks: Object.fromEntries(squad.map((p) => [p.id, checkPerson(plan, p)])),
  };
}

/** Hard limits that fail (and aren't waived), person by person. */
export function problems(sol: Solution, squad: SquadMember[]): { member: SquadMember; check: ConstraintCheck }[] {
  return squad.flatMap((p) => failingHard(sol.checks[p.id] ?? []).map((check) => ({ member: p, check })));
}

export type Compromise = {
  key: "cheaper_flights" | "cheaper_hotel" | "both" | "go_over" | "earlier_flight";
  label: string;
  /** What the person pays with this option. */
  total?: number;
  /** Who else it changes, for the message. */
  affects: string[];
  /** Still breaks the limit after applying it. */
  stillOver?: number;
  apply: { priceFirst?: string[]; hotelId?: string; waive?: string };
};

const totalFor = (sol: Solution, name: string) => sol.costs.find((c) => c.person === name)?.total ?? 0;

/**
 * The smallest compromises for one broken budget, from real alternatives:
 * this person's cheapest allowed flights, the cheapest hotel in the search,
 * both, or keeping the plan and going over by an exact amount.
 */
export function budgetCompromises(pool: CandidatePool, trip: Trip, squad: SquadMember[], sol: Solution, member: SquadMember, cap: number): Compromise[] {
  const now = totalFor(sol, member.name);
  const out: Compromise[] = [];
  const over = (t: number) => (t > cap ? t - cap : undefined);

  const flights = solve(pool, trip, squad, { hotel: sol.hotel, priceFirst: [...new Set([...sol.priceFirst, member.name])] });
  const tFlights = totalFor(flights, member.name);
  if (tFlights < now) {
    const f = flights.flights.find((x) => x.person === member.name);
    const legs = [f?.out, f?.back].filter(Boolean).map((x) => `${x!.from} ${x!.departTime.slice(11, 16)}${x!.stops ? `, ${x!.stops} stop` : ""}`).join(" / ");
    out.push({ key: "cheaper_flights", label: `Your cheapest flights (${legs})`, total: tFlights, affects: [], stillOver: over(tFlights), apply: { priceFirst: flights.priceFirst } });
  }

  const cheapHotel = chooseHotel(pool, { cheapest: true });
  if (cheapHotel && sol.hotel && cheapHotel.id !== sol.hotel.id) {
    const h = solve(pool, trip, squad, { hotel: cheapHotel, priceFirst: sol.priceFirst });
    const tHotel = totalFor(h, member.name);
    if (tHotel < now) {
      out.push({
        key: "cheaper_hotel",
        label: `Cheaper stay: ${cheapHotel.name} (${formatINR(cheapHotel.pricePerNight!)}/night)`,
        total: tHotel,
        affects: squad.filter((p) => p.id !== member.id).map((p) => p.name),
        stillOver: over(tHotel),
        apply: { hotelId: cheapHotel.id },
      });
      if (tFlights < now) {
        const both = solve(pool, trip, squad, { hotel: cheapHotel, priceFirst: flights.priceFirst });
        const tBoth = totalFor(both, member.name);
        if (tBoth < Math.min(tFlights, tHotel)) out.push({ key: "both", label: "Both: your cheapest flights and the cheaper stay", total: tBoth, affects: squad.filter((p) => p.id !== member.id).map((p) => p.name), stillOver: over(tBoth), apply: { priceFirst: flights.priceFirst, hotelId: cheapHotel.id } });
      }
    }
  }

  // Options that fix it first (smallest change first), then the closest partial one, then going over.
  const bySize = (a: Compromise, b: Compromise) => a.affects.length - b.affects.length || (a.total ?? 0) - (b.total ?? 0);
  const fixes = out.filter((o) => !o.stillOver).sort(bySize);
  const partial = out.filter((o) => o.stillOver).sort((a, b) => (a.stillOver ?? 0) - (b.stillOver ?? 0));
  const ranked = [...fixes, ...partial].slice(0, 2);
  ranked.push({ key: "go_over", label: `Keep it and go ${formatINR(now - cap)} over`, total: now, affects: [], apply: { waive: `go ${formatINR(now - cap)} over` } });
  return ranked;
}
