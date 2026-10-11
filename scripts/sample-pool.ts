// Gathers the demo squad's real Goa candidates and saves a summary for card previews.
import { DEMO_SQUAD, DEMO_TRIP } from "../src/core/demo.js";
import { gatherCandidates } from "../src/core/gather.js";

const pool = await gatherCandidates(DEMO_TRIP, DEMO_SQUAD, (t) => console.log("  " + t));
const live = pool.receipts.filter((r) => r.source === "live").length;
console.log(`\nflights out: ${Object.entries(pool.flightsOut).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
console.log(`flights back: ${Object.entries(pool.flightsBack).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
console.log(`hotels ${pool.hotels.length} · places ${pool.places.length} · events ${pool.events.length} · drops ${pool.drops.length}`);
console.log(`searches ${pool.receipts.length} (${live} live) · errors: ${pool.errors.join(" | ") || "none"}`);
console.log(`Ishita's earliest out: ${pool.flightsOut.Ishita.map((f) => f.departTime.slice(11)).sort()[0]} · Kabir's earliest out: ${pool.flightsOut.Kabir.map((f) => f.departTime.slice(11)).sort()[0]}`);
console.log(`veg places: ${pool.places.filter((p) => /veg/i.test(`${p.category} ${p.description}`)).map((p) => `${p.name} (${p.category})`).slice(0, 4).join("; ")}`);
console.log(`Chapora: ${pool.places.filter((p) => /chapora/i.test(p.name)).map((p) => `${p.name} ${p.rating}★ (${p.reviews})`).join("; ")}`);
