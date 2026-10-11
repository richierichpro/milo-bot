// One search per SerpApi engine for Aarav's trip (HYD → Goa, 20–23 Nov 2026):
// prints 2 items per type plus everything dropped and why.
import { checkEvents, checkPlaces } from "../src/core/checks.js";
import { getTravelTime } from "../src/core/directions.js";
import * as n from "../src/core/normalize.js";
import * as q from "../src/core/queries.js";
import { serpSearch } from "../src/core/serpapi.js";
import type { CallLogEntry } from "../src/core/types.js";

const log: CallLogEntry[] = [];
const trip = { destination: "Goa", startDate: "2026-11-20", endDate: "2026-11-23" };
const show = (label: string, items: unknown[], pick: (x: any) => string) =>
  console.log(`\n${label} (${items.length})\n` + items.slice(0, 2).map((x) => `  • ${pick(x)}`).join("\n"));

const [flights, hotels, maps, events, explore] = await Promise.all([
  serpSearch(q.flightParams("HYD", "GOI,GOX", trip.startDate), { log }),
  serpSearch(q.hotelParams("Goa", trip.startDate, trip.endDate), { log }),
  serpSearch(q.mapsParams("top attractions in Goa"), { log }),
  serpSearch(q.eventsParams(q.eventsQuery("Goa")), { log }),
  serpSearch(q.exploreParams("HYD", trip.startDate, trip.endDate), { log }),
]);

show("✈️ Flights HYD → Goa", n.normalizeFlights(flights), (f) => `${f.from} ${f.departTime.slice(11)} → ${f.to} ${f.arriveTime.slice(11)} · ${f.stops ? `${f.stops} stop via ${f.via.join(",")}` : "nonstop"} · ₹${f.pricePerPerson}`);
const hs = n.normalizeHotels(hotels);
show("🏨 Hotels", hs, (h) => `${h.name} · ₹${h.pricePerNight ?? "?"}/night · ${h.rating ?? "?"}★ · check-in ${h.checkInTime ?? "?"} / out ${h.checkOutTime ?? "?"}`);
const places = checkPlaces(n.normalizePlaces(maps));
show("📍 Places (kept)", places.kept, (p) => `${p.name} · ${p.rating}★ (${p.reviews}) · ${p.operatingHours?.friday ?? "hours not listed"}`);
const ev = checkEvents(n.normalizeEvents(events, 2026), trip);
show("🎟 Events (kept)", ev.kept, (e) => `${e.title} · ${e.date} · ${e.venue}`);
const dests = n.normalizeDestinations(explore);
show("🗺 Destinations from HYD", dests, (d) => `${d.name} (${d.airportCode}) · round trip ₹${d.flightPrice} · hotel_price ${d.hotelPrice ?? "not returned"}`);

const from = hs[0];
const to = places.kept[0];
const tt = await getTravelTime(from, to, "driving", new Date("2026-11-21T04:30:00Z"), { log });
console.log(`\n🚗 Directions: ${from.name} → ${to.name}: ${tt ? `${tt.text} · ${tt.km} km` : "no route"}`);

console.log(`\nDropped (${places.drops.length + ev.drops.length}):`);
for (const d of [...places.drops, ...ev.drops]) console.log(`  ✗ ${d.kind}: ${d.name} (${d.reason})`);
console.log(`\nSearches: ${log.map((l) => `${l.engine}=${l.source}`).join(", ")}`);
