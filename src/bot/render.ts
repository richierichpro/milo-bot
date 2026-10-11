import * as t from "../cards/templates.js";
import type { ConstraintCheck } from "../core/constraints.js";
import { airportSplitNote } from "../core/squad.js";
import type { DestinationShortlist } from "../core/squad.js";
import type { Constraint, CostLine, Flight, FlightPick, Hotel, Source, SquadMember } from "../core/types.js";

// Turns Milo's data into card inputs. Every value shown comes from search
// results or from the squad's own words; nothing is added here.

const ENGINE: Record<string, string> = {
  google_flights: "Google Flights",
  google_hotels: "Google Hotels",
  google_maps: "Google Maps",
  google: "Google Events",
  google_travel_explore: "Google Travel Explore",
  google_maps_directions: "Google Maps Directions",
};
export const engineLabel = (e: string) => ENGINE[e] ?? e;

export function timeAgo(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export const proofText = (s: Source, now = Date.now()) => `${engineLabel(s.engine)} · checked ${timeAgo(s.fetchedAt, now)}`;

/** "2026-11-20" → "Fri 20 Nov" */
export function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}
export const dateRange = (a: string, b: string) => {
  const [, da, ma] = dayLabel(a).split(" ");
  const [, db, mb] = dayLabel(b).split(" ");
  return ma === mb ? `${da}–${db} ${mb}` : `${da} ${ma}–${db} ${mb}`;
};

const rupeesK = (n: number) => (n % 1000 === 0 ? `₹${n / 1000}k` : t.rupees(n));

/** A short chip for one constraint, as shown on the Heard card. */
export function chipLabel(c: Constraint): string {
  switch (c.kind) {
    case "budget":
      return `max ${rupeesK(c.max)}`;
    case "dates":
      return `free ${dateRange(c.start, c.end)}`;
    case "food":
      return c.diet === "veg" ? "veg" : c.diet === "allergy" ? `allergy: ${c.detail ?? "?"}` : c.diet;
    case "flight_time": {
      const when = c.date ? ` ${dayLabel(c.date).split(" ").slice(0, 1).join("")}` : "";
      const leg = c.direction === "out" ? "flies out" : c.direction === "back" ? "flies back" : "flights";
      return [c.notBefore && `${leg} after ${c.notBefore}${when}`, c.notAfter && `${leg} before ${c.notAfter}${when}`].filter(Boolean).join(", ");
    }
    case "must_do":
      return `must: ${c.what}`;
    case "no_go":
      return `no: ${c.what}`;
    case "vibe":
      return c.what;
  }
}

export function heardHtml(squad: SquadMember[]): string {
  return t.heardCard(squad.map((p) => ({ name: p.name, city: p.city, chips: p.constraints.filter((c) => !c.waived).map((c) => ({ label: chipLabel(c), hard: c.hard })) })));
}

export function shortlistHtml(s: DestinationShortlist): string {
  return t.shortlistCard(
    s.options.map((o) => ({
      name: o.destination.name,
      thumbnail: o.destination.thumbnail,
      each: o.groupTotal / o.perPerson.length,
      perPerson: o.perPerson.map((p) => ({ person: p.person, total: p.total, within: p.withinBudget })),
      hotelNote: o.hotelPerNight ? `hotels ~${t.rupees(o.hotelPerNight)}/night within the tightest budget` : "hotel prices couldn't be checked",
      mentioned: o.mentioned,
    })),
    "Estimates: round-trip fares from Google Travel Explore + a typical budget hotel on Google Hotels, room shared by two.",
  );
}

// ---------- Flights ----------

const clock = (s: string) => s.slice(11, 16);
const minutes = (s: string) => Date.parse(`${s.replace(" ", "T")}:00Z`) / 60_000;
function duration(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}
const stopsText = (f: Flight) => (f.stops ? `${f.stops} stop${f.stops > 1 ? "s" : ""}${f.via?.length ? ` via ${f.via.join(", ")}` : ""}` : "nonstop");

function leg(f: Flight | undefined): t.FlightLeg | undefined {
  if (!f) return undefined;
  return {
    from: f.from,
    to: f.to,
    depart: clock(f.departTime),
    arrive: clock(f.arriveTime),
    nextDay: f.arriveTime.slice(0, 10) !== f.departTime.slice(0, 10),
    airline: f.airline,
    logo: f.airlineLogo,
    duration: duration(f.durationMin),
    stops: stopsText(f),
    price: f.pricePerPerson,
    numbers: f.flightNumbers.join(", "),
  };
}

export function flightsHtml(destination: string, picks: FlightPick[], extraVsCheapest: number | undefined, now = Date.now()): string {
  const rows = picks.map((p) => ({ person: p.person, city: p.city, out: leg(p.out), back: leg(p.back), checked: p.out ? timeAgo(p.out.source.fetchedAt, now) : undefined }));
  const arrivals = picks.filter((p) => p.out).map((p) => ({ person: p.person, time: clock(p.out!.arriveTime), minutes: minutes(p.out!.arriveTime), airport: p.out!.to }));
  const airports = [...new Set(arrivals.map((a) => a.airport))];
  const sorted = [...arrivals].sort((a, b) => a.minutes - b.minutes);
  const window =
    arrivals.length > 1
      ? {
          headline: `Everyone lands between ${sorted[0].time} and ${sorted.at(-1)!.time}${airports.length === 1 ? ` at ${airports[0]}` : ""}`,
          sub: extraVsCheapest && extraVsCheapest > 0 ? `${t.rupees(extraVsCheapest)} more than the cheapest scattered flights` : "the cheapest way to arrive together",
          warning: [airportSplitNote(picks, "out"), airportSplitNote(picks, "back")].filter(Boolean).join(" ") || undefined,
        }
      : undefined;
  return t.flightsCard(destination, rows, arrivals, window);
}

export function hotelHtml(h: Hotel, nights: number, rooms: number, distanceKm: number | undefined, now = Date.now()): string {
  return t.hotelCard({
    name: h.name,
    photo: h.thumbnail,
    stars: h.stars,
    rating: h.rating,
    reviews: h.reviews,
    perNight: h.pricePerNight,
    rooms,
    nights,
    distanceKm,
    checkIn: h.checkInTime,
    checkOut: h.checkOutTime,
    amenities: h.amenities,
    checked: timeAgo(h.source.fetchedAt, now),
  });
}

export function costHtml(costs: CostLine[], squad: SquadMember[], nights: number, rooms: number): string {
  const budget = (name: string) => squad.find((p) => p.name === name)?.constraints.flatMap((c) => (c.kind === "budget" && c.hard ? [c.max] : []))[0];
  return t.costSplitCard(costs.map((c) => ({ ...c, budget: budget(c.person) })), nights, rooms);
}

export function passHtml(member: SquadMember, index: number, pick: FlightPick | undefined, cost: CostLine | undefined, checks: ConstraintCheck[], trip: { destination: string; startDate: string; endDate: string }, hotelName?: string): string {
  const o = pick?.out;
  const b = pick?.back;
  return t.boardingPassCard({
    person: member.name,
    index,
    destination: trip.destination,
    dates: dateRange(trip.startDate, trip.endDate),
    out: o ? { from: o.from, to: o.to, depart: clock(o.departTime), arrive: clock(o.arriveTime), date: dayLabel(o.departTime.slice(0, 10)), numbers: o.flightNumbers.join(", "), airline: o.airline } : undefined,
    back: b ? { from: b.from, to: b.to, depart: clock(b.departTime), date: dayLabel(b.departTime.slice(0, 10)), numbers: b.flightNumbers.join(", ") } : undefined,
    hotel: hotelName,
    total: cost?.total ?? 0,
    checks: checks.filter((c) => !c.pending).map((c) => ({ ok: c.ok, waived: c.waived, text: c.evidence })),
  });
}
