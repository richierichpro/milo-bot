// Renders the latest plan's day cards and boarding passes to a folder (no API calls).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dayData } from "../src/bot/postplan.js";
import { passHtml } from "../src/bot/render.js";
import type { ChatState } from "../src/bot/state.js";
import { closeRenderer, renderCard } from "../src/cards/render.js";
import * as t from "../src/cards/templates.js";
import { checkPerson } from "../src/core/constraints.js";
import type { TripPlan } from "../src/core/planner.js";

const out = process.argv[2] ?? "/tmp/milo-plan";
await mkdir(out, { recursive: true });
const dir = path.join(process.env.MILO_DATA_DIR ?? ".data-sim", "chats");
const s = (await Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(path.join(dir, f), "utf8")) as ChatState))).find((x) => x.data.plan)!;
const plan = s.data.plan as TripPlan;
for (const [i, d] of plan.days.entries()) {
  const data = dayData(d, i, plan);
  await writeFile(path.join(out, `day-${i + 1}.png`), (await renderCard(t.dayCard(data), () => t.dayCard(data, { withMap: false }))).png);
}
const sol = plan.solution;
const p2 = { startDate: plan.trip.startDate, endDate: plan.trip.endDate, flights: sol.flights, costs: sol.costs, hotel: sol.hotel, days: plan.days };
for (const [i, p] of s.squad.entries())
  await writeFile(path.join(out, `pass-${p.name.toLowerCase()}.png`), (await renderCard(passHtml(p, i, sol.flights.find((f) => f.person === p.name), sol.costs.find((c) => c.person === p.name), checkPerson(p2, p), plan.trip, sol.hotel?.name))).png);
await closeRenderer();
console.log("done");
