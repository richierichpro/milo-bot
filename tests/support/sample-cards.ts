// Renders every card from the demo squad's real Goa data into a folder, for eyeballing.
// No Claude: days are simple groupings of real places (the planner does this properly in Step 7).
import { costHtml, flightsHtml, heardHtml, hotelHtml, passHtml, proofText, shortlistHtml, dayLabel } from "../../src/bot/render.js";
import * as t from "../../src/cards/templates.js";
import { checkPerson } from "../../src/core/constraints.js";
import { DEMO_SQUAD, DEMO_TRIP } from "../../src/core/demo.js";
import { gatherCandidates } from "../../src/core/gather.js";
import { centreOf, haversineKm, typicalDistanceKm } from "../../src/core/geo.js";
import { costSplit, nightsBetween, roomsFor } from "../../src/core/money.js";
import { findDestinations, pickSquadFlights } from "../../src/core/squad.js";


export type SampleCard = [name: string, html: string, withoutMap?: () => string];

/** Every card built from the demo squad's real (cached or recorded) Goa search results. */
export async function buildSampleCards(): Promise<SampleCard[]> {
  const now = Date.now();
  const pool = await gatherCandidates(DEMO_TRIP, DEMO_SQUAD);
  const shortlist = await findDestinations(DEMO_SQUAD, DEMO_TRIP, { mentioned: ["Goa"] });
  const picked = pickSquadFlights(pool.flightsOut, pool.flightsBack, DEMO_SQUAD);
  const centre = centreOf(pool.places)!;
  const hotel = [...pool.hotels].sort((a, b) => haversineKm(a, centre) - haversineKm(b, centre))[0];
  const nights = nightsBetween(DEMO_TRIP.startDate, DEMO_TRIP.endDate);
  const rooms = roomsFor(DEMO_SQUAD.length);
  const costs = costSplit(picked.flights, hotel, nights);

  // Preview days: real places nearest the hotel, 3 per day.
  const near = [...pool.places].sort((a, b) => haversineKm(a, hotel) - haversineKm(b, hotel)).slice(0, 9);
  const times = ["10:00", "13:00", "17:30"];
  const days = [0, 1, 2].map((i) => {
    const date = new Date(Date.parse(DEMO_TRIP.startDate) + (i + 1) * 86_400_000).toISOString().slice(0, 10);
    return {
      index: i + 1,
      date: dayLabel(date),
      title: `Preview day ${i + 2}`,
      leaveBy: "09:30",
      travel: "≈ 40 min",
      hotel: { lat: hotel.lat, lng: hotel.lng, name: hotel.name },
      stops: near.slice(i * 3, i * 3 + 3).map((p, j) => ({
        time: times[j],
        name: p.name,
        category: p.category,
        rating: p.rating,
        reviews: p.reviews,
        price: p.priceLevel,
        photo: p.thumbnail,
        proof: proofText(p.source, now),
        lat: p.lat,
        lng: p.lng,
        hop: j ? "≈ 2 km, short ride" : undefined,
      })),
    };
  });
  const plan = { startDate: DEMO_TRIP.startDate, endDate: DEMO_TRIP.endDate, flights: picked.flights, costs, hotel };

  const cards: SampleCard[] = [
    ["01-heard", heardHtml(DEMO_SQUAD)],
    ["02-shortlist", shortlistHtml(shortlist)],
    ["03-vote", t.voteCard("Where are we going?", shortlist.options.slice(0, 3).map((o, i) => ({ label: o.destination.name, sub: `≈ ${t.rupees(o.groupTotal / o.perPerson.length)} each`, votes: [2, 1, 0][i], voters: [["Aarav", "Meera"], ["Kabir"], []][i] })), "Voting closes in 2 h · one vote each")],
    ["04-decided", t.decidedCard("Where are we going?", "Goa", "3 of 4 votes · 20–23 Nov", "Closed early: everyone voted.")],
    ["05-header", t.headerCard({ title: "Goa with the squad", destination: "Goa", dates: "20–23 Nov", perPerson: costs.reduce((s, c) => s + c.total, 0) / costs.length, summary: "Preview: the planner writes this in Step 7.", squad: DEMO_SQUAD.map((p) => p.name), verified: { verified: 20, total: 20 }, searches: pool.receipts.length })],
    ["06-flights", flightsHtml("Goa", picked.flights, picked.arrivalWindow?.extraVsCheapest, now)],
    ["07-hotel", hotelHtml(hotel, nights, rooms, typicalDistanceKm(hotel, near), now)],
    ...days.map((d) => [`08-day-${d.index + 1}`, t.dayCard(d), () => t.dayCard(d, { withMap: false })] as [string, string, () => string]),
    ...DEMO_SQUAD.map((m, i) => [`09-pass-${m.name.toLowerCase()}`, passHtml(m, i, picked.flights.find((f) => f.person === m.name), costs.find((c) => c.person === m.name), checkPerson(plan, m), DEMO_TRIP, hotel.name)] as [string, string]),
    ["10-cost", costHtml(costs, DEMO_SQUAD, nights, rooms)],
  ];
  return cards;
}
