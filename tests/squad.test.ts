import { strict as assert } from "node:assert";
import { test } from "vitest";
import { pickSquadFlights } from "../src/core/squad.js";
import type { Flight } from "../src/core/types.js";

const src = { engine: "google_flights", fetchedAt: "2026-10-09T00:00:00Z" };
const f = (id: string, depart: string, arrive: string, price: number): Flight => ({
  id, source: src, from: "X", to: "GOI", departTime: `2026-11-20 ${depart}`, arriveTime: `2026-11-20 ${arrive}`,
  airline: "Test Air", flightNumbers: [id], stops: 0, via: [], durationMin: 90, pricePerPerson: price,
});
const back = (id: string, depart: string, price: number) => ({ ...f(id, depart, "23:59", price), departTime: `2026-11-23 ${depart}` });
const squad = [{ name: "A", city: "Pune" }, { name: "B", city: "Delhi" }];

test("prefers aligned arrivals when the price difference is small", () => {
  const out = {
    A: [f("A-cheap-early", "05:00", "07:00", 4000), f("A-aligned", "09:00", "11:00", 4300)],
    B: [f("B-only", "08:30", "11:20", 5000)],
  };
  const r = pickSquadFlights(out, { A: [back("Ab", "18:00", 4000)], B: [back("Bb", "18:30", 4000)] }, squad);
  assert.equal(r.flights[0].out?.id, "A-aligned"); // 20 min apart for ₹300 more beats 4h20m apart
  assert.equal(r.arrivalWindow?.first, "2026-11-20 11:00");
  assert.equal(r.arrivalWindow?.last, "2026-11-20 11:20");
  assert.equal(r.arrivalWindow?.extraVsCheapest, 300);
});

test("still picks the cheap flight when alignment would cost a lot more", () => {
  const out = {
    A: [f("A-cheap", "05:00", "07:00", 4000), f("A-pricey", "09:00", "11:00", 20000)],
    B: [f("B-only", "08:30", "07:30", 5000)],
  };
  const r = pickSquadFlights(out, { A: [back("Ab", "18:00", 4000)], B: [back("Bb", "18:30", 4000)] }, squad);
  assert.equal(r.flights[0].out?.id, "A-cheap");
});

test("return departures are aligned too", () => {
  const out = { A: [f("Ao", "09:00", "11:00", 4000)], B: [f("Bo", "09:00", "11:10", 4000)] };
  const r = pickSquadFlights(out, {
    A: [back("A-0600", "06:00", 3500), back("A-1800", "18:00", 3800)],
    B: [back("B-1830", "18:30", 4000)],
  }, squad);
  assert.equal(r.flights[0].back?.id, "A-1800");
});

test("a friend whose flight search failed doesn't block everyone else", () => {
  const r = pickSquadFlights(
    { A: [f("Ao", "09:00", "11:00", 4000)], B: [] },
    { A: [back("Ab", "18:00", 4000)] },
    squad,
  );
  assert.equal(r.flights[0].out?.id, "Ao");
  assert.equal(r.flights[1].out, undefined);
});

test("prefers everyone at the same airport over a slightly cheaper split", () => {
  const at = (fl: Flight, to: string) => ({ ...fl, to });
  const out = {
    A: [at(f("A-GOX", "09:00", "11:00", 4000), "GOX")],
    B: [at(f("B-GOI-cheap", "09:00", "11:05", 4500), "GOI"), at(f("B-GOX", "09:00", "11:10", 6000), "GOX")],
  };
  const r = pickSquadFlights(out, { A: [back("Ab", "18:00", 4000)], B: [back("Bb", "18:30", 4000)] }, squad);
  assert.equal(r.flights[1].out?.id, "B-GOX"); // ₹1,500 more beats a ₹4,000 split
});

test("prefers a nonstop over a long one-stop at a similar price", () => {
  const slow = { ...f("A-1stop", "05:00", "11:00", 4000), stops: 1, durationMin: 360 };
  const fast = { ...f("A-nonstop", "09:45", "11:00", 4800), durationMin: 75 };
  const r = pickSquadFlights({ A: [slow, fast], B: [f("Bo", "09:00", "11:00", 4000)] }, { A: [back("Ab", "18:00", 4000)], B: [back("Bb", "18:00", 4000)] }, squad);
  assert.equal(r.flights[0].out?.id, "A-nonstop");
});

test("priceFirst gives that person their cheapest flight", () => {
  const out = {
    A: [f("A-cheap-early", "05:00", "07:00", 3000), f("A-aligned", "09:00", "11:00", 4300)],
    B: [f("B-only", "08:30", "11:20", 5000)],
  };
  const backs = { A: [back("Ab", "18:00", 4000)], B: [back("Bb", "18:30", 4000)] };
  assert.equal(pickSquadFlights(out, backs, squad).flights[0].out?.id, "A-aligned");
  assert.equal(pickSquadFlights(out, backs, squad, { priceFirst: ["A"] }).flights[0].out?.id, "A-cheap-early");
});

test("priceFirst with keep leaves everyone else on their flights", () => {
  const bOld = f("B-old", "08:30", "11:20", 5000);
  const out = { A: [f("A-cheap", "05:00", "07:00", 3000), f("A-aligned", "09:00", "11:00", 4300)], B: [f("B-new", "04:00", "06:00", 4000), bOld] };
  const backs = { A: [back("Ab", "18:00", 4000)], B: [back("Bb", "18:30", 4000)] };
  const r = pickSquadFlights(out, backs, squad, { priceFirst: ["A"], keep: [{ person: "B", city: "Delhi", out: bOld, back: backs.B[0] }] });
  assert.equal(r.flights[0].out?.id, "A-cheap");
  assert.equal(r.flights[1].out?.id, "B-old");
});

// ---------- Hard time limits (Milo) ----------
import type { Constraint, SquadMember } from "../src/core/types.js";

const limit = (c: Omit<Extract<Constraint, { kind: "flight_time" }>, "id" | "hard" | "kind">): Constraint => ({ id: "t", hard: true, kind: "flight_time", ...c });
const dated = (id: string, day: string, depart: string, arrive: string, price: number, extra: Partial<Flight> = {}): Flight => ({
  ...f(id, depart, arrive, price),
  departTime: `${day} ${depart}`,
  arriveTime: `${day} ${arrive}`,
  ...extra,
});

test("Kabir never gets a flight before 18:00 on Friday 20 Nov, even when it's much cheaper", () => {
  const kabir = { name: "Kabir", city: "Delhi", constraints: [limit({ direction: "out", date: "2026-11-20", notBefore: "18:00", reason: "office till 6" })] };
  const aarav = { name: "Aarav", city: "Hyderabad", constraints: [] };
  const out = {
    Kabir: [dated("K-0845", "2026-11-20", "08:45", "11:30", 4000), dated("K-1835", "2026-11-20", "18:35", "21:15", 10087)],
    Aarav: [dated("A-1100", "2026-11-20", "11:00", "12:20", 5000), dated("A-1900", "2026-11-20", "19:00", "20:20", 6000)],
  };
  const r = pickSquadFlights(out, { Kabir: [back("Kb", "18:00", 4000)], Aarav: [back("Ab", "18:00", 4000)] }, [kabir, aarav]);
  assert.equal(r.flights[0].out?.id, "K-1835");
  assert.ok(r.flights[0].out!.departTime.slice(11) >= "18:00");
});

test("Ishita never gets a flight before 08:00 in either direction", () => {
  const ishita = { name: "Ishita", city: "Pune", constraints: [limit({ direction: "any", notBefore: "08:00" })] };
  const out = { Ishita: [dated("I-0530", "2026-11-20", "05:30", "06:40", 3000), dated("I-1415", "2026-11-20", "14:15", "15:25", 5497)] };
  const backs = { Ishita: [dated("Ib-0715", "2026-11-23", "07:15", "08:30", 3000), dated("Ib-1505", "2026-11-23", "15:05", "16:15", 5500)] };
  const r = pickSquadFlights(out, backs, [ishita]);
  assert.equal(r.flights[0].out?.id, "I-1415");
  assert.equal(r.flights[0].back?.id, "Ib-1505");
});

test("same-airport nonstops beat a cheap 6-hour one-stop when the price gap is small", () => {
  const a = { name: "A", city: "Pune" };
  const b = { name: "B", city: "Delhi" };
  const out = {
    A: [
      dated("A-1stop-GOI", "2026-11-20", "05:00", "11:00", 4000, { stops: 1, via: ["BOM"], durationMin: 360, to: "GOI" }),
      dated("A-nonstop-GOX", "2026-11-20", "09:50", "11:00", 5200, { durationMin: 70, to: "GOX" }),
    ],
    B: [dated("B-nonstop-GOX", "2026-11-20", "08:30", "11:10", 9000, { durationMin: 160, to: "GOX" })],
  };
  const r = pickSquadFlights(out, { A: [back("Ab", "18:00", 4000)], B: [back("Bb", "18:00", 4000)] }, [a, b]);
  assert.equal(r.flights[0].out?.id, "A-nonstop-GOX");
});

// ---------- checkPerson and equalSplit ----------
import { checkPerson, failingHard } from "../src/core/constraints.js";
import { equalSplit } from "../src/core/money.js";

const ishitaMember: SquadMember = {
  id: "i",
  name: "Ishita",
  city: "Pune",
  constraints: [
    { id: "b", hard: true, kind: "budget", max: 15000 },
    limit({ direction: "any", notBefore: "08:00" }),
    { id: "v", hard: true, kind: "food", diet: "veg" },
  ],
};
const veggie = { kind: "place" as const, time: "13:00", why: "", item: { id: "place:v", source: src, name: "Veg Treat", category: "Vegetarian restaurant", lat: 0, lng: 0, mapsUrl: "" } };
const plan = (total: number, departOut: string) => ({
  startDate: "2026-11-20",
  endDate: "2026-11-23",
  flights: [{ person: "Ishita", city: "Pune", out: dated("o", "2026-11-20", departOut, "15:25", 5000), back: dated("b", "2026-11-23", "15:05", "16:15", 5000) }],
  costs: [{ person: "Ishita", flights: total - 4000, hotelShare: 4000, total }],
  days: [{ date: "2026-11-20", title: "d1", stops: [veggie] }],
});

test("checkPerson passes with evidence from the data", () => {
  const r = checkPerson(plan(14900, "14:15"), ishitaMember);
  assert.deepEqual(failingHard(r), []);
  assert.match(r[0].evidence, /₹14,900 for you .*within your ₹15,000/);
  assert.match(r[1].evidence, /Flight leaves X 14:15, after 08:00/);
  assert.match(r[2].evidence, /veg meal every day, e\.g\. Veg Treat \(Vegetarian restaurant\)/);
});

test("checkPerson reports breaks, and a waiver turns a break into an agreed exception", () => {
  const r = checkPerson(plan(16400, "05:30"), ishitaMember);
  assert.deepEqual(failingHard(r).map((x) => x.constraint.kind), ["budget", "flight_time"]);
  assert.match(r[0].evidence, /₹1,400 over your ₹15,000 cap/);
  const waived = { ...ishitaMember, constraints: ishitaMember.constraints.map((c) => (c.kind === "budget" ? { ...c, waived: "agreed to go ₹1,400 over" } : c)) };
  const w = checkPerson(plan(16400, "14:15"), waived);
  assert.deepEqual(failingHard(w), []);
  assert.equal(w[0].waived, "agreed to go ₹1,400 over");
});

test("equalSplit settles everyone to zero", () => {
  const line = (person: string, total: number) => ({ person, flights: total, hotelShare: 0, total });
  const costs = [line("Aarav", 15000), line("Meera", 14000), line("Kabir", 22000), line("Ishita", 13000)];
  const { average, transfers } = equalSplit(costs);
  const paid = new Map(costs.map((c) => [c.person, c.total]));
  for (const t of transfers) {
    paid.set(t.from, paid.get(t.from)! + t.amount);
    paid.set(t.to, paid.get(t.to)! - t.amount);
  }
  for (const v of paid.values()) assert.equal(v, average);
});
