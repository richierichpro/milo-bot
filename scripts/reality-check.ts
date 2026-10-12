// Re-checks the latest plan Milo posted against the search results: PASS/FAIL per item.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { bookingList, daysText, flightsText, passText, sourcesMessages, TEXT_MAX } from "../src/bot/postplan.js";
import type { ChatState } from "../src/bot/state.js";
import { isOpenAt, MIN_REVIEWS } from "../src/core/checks.js";
import { checkPerson, failingHard } from "../src/core/constraints.js";
import { flightAllowed } from "../src/core/squad.js";
import { gatherCandidates } from "../src/core/gather.js";
import { noteProblem, type TripPlan } from "../src/core/planner.js";

process.env.SERPAPI_OFFLINE ??= "true";
const dir = path.join(process.env.MILO_DATA_DIR ?? ".data-sim", "chats");
const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json"));
const states = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), "utf8")) as ChatState));
const s = states.filter((x) => x.data.plan).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
if (!s) {
  console.log("No plan found. Run `npm run simulate` first.");
  process.exit(1);
}
const plan = s.data.plan as TripPlan;
const pool = await gatherCandidates(plan.trip, s.squad);
const ids = new Set([...pool.places, ...pool.events, ...pool.hotels, ...Object.values(pool.flightsOut).flat(), ...Object.values(pool.flightsBack).flat()].map((x) => x.id));

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string, why = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && why ? `  ← ${why}` : ""}`);
};
const names = [plan.trip.destination, ...s.squad.map((p) => p.name)];

for (const f of plan.solution.flights) {
  const p = s.squad.find((x) => x.name === f.person)!;
  for (const [leg, dir2] of [[f.out, "out"], [f.back, "back"]] as const) {
    if (!leg) continue;
    check(ids.has(leg.id) && flightAllowed(p.constraints, leg, dir2), `flight ${f.person} ${dir2} ${leg.from} ${leg.departTime.slice(11)} → ${leg.to}`, ids.has(leg.id) ? "breaks a time limit" : "not in search results");
  }
}
const h = plan.solution.hotel;
if (h) check(ids.has(h.id), `hotel ${h.name}`, "not in search results");
for (const [i, d] of plan.days.entries()) {
  for (const st of d.stops) {
    const it = st.item;
    const name = "name" in it ? it.name : it.title;
    const reasons: string[] = [];
    if (!ids.has(it.id)) reasons.push("not in search results");
    if ("name" in it) {
      if (/closed/i.test(it.status ?? "") && /temporarily|permanently/i.test(it.status ?? "")) reasons.push(it.status!);
      if ((it.reviews ?? 0) < MIN_REVIEWS) reasons.push(`only ${it.reviews ?? 0} reviews`);
      const open = isOpenAt(it, d.date, st.time);
      if (open === false) reasons.push(`closed at ${st.time}`);
      if (open === undefined && st.hoursNote !== "hours not listed") reasons.push("unknown hours not flagged");
    }
    const note = noteProblem(st.why, it, names);
    if (note) reasons.push(`note: ${note}`);
    check(!reasons.length, `day ${i + 1} ${st.time} ${name}`, reasons.join("; "));
  }
}
const plan2 = { startDate: plan.trip.startDate, endDate: plan.trip.endDate, flights: plan.solution.flights, costs: plan.solution.costs, hotel: h, days: plan.days };
for (const p of s.squad) {
  const bad = failingHard(checkPerson(plan2, p));
  check(!bad.length, `${p.name}: every hard limit met or agreed`, bad.map((b) => b.evidence).join("; "));
}
const balanced = (html: string) => {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)(b|i|code|a|blockquote|pre|u|s)(?:\s[^>]*)?>/g)) {
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
};
const texts = [flightsText(plan), daysText(plan), passText(plan, s.squad), bookingList(plan), ...sourcesMessages(plan)];
check(texts.every((x) => x.length <= TEXT_MAX && balanced(x)), `${texts.length} text messages ≤ ${TEXT_MAX} chars with valid HTML`);

console.log(`\n${pass}/${pass + fail} items pass${fail ? ` · ${fail} FAIL` : ""}`);
process.exit(fail ? 1 : 0);
