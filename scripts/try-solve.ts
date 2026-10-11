// Solves the demo squad's Goa trip from cached searches and prints any compromise needed.
import { DEMO_SQUAD, DEMO_TRIP } from "../src/core/demo.js";
import { gatherCandidates } from "../src/core/gather.js";
import { formatINR } from "../src/core/money.js";
import { budgetCompromises, problems, solve } from "../src/core/solve.js";

const pool = await gatherCandidates(DEMO_TRIP, DEMO_SQUAD);
const sol = solve(pool, DEMO_TRIP, DEMO_SQUAD);
console.log(`hotel: ${sol.hotel?.name} ₹${sol.hotel?.pricePerNight}/night`);
for (const f of sol.flights) console.log(`  ${f.person}: ${f.out?.from} ${f.out?.departTime.slice(11)}→${f.out?.to} ${f.out?.arriveTime.slice(11)} | back ${f.back?.from} ${f.back?.departTime.slice(11)} · total ${formatINR(sol.costs.find((c) => c.person === f.person)!.total)}`);
for (const p of DEMO_SQUAD) for (const c of sol.checks[p.id]) console.log(`  ${p.name}: ${c.pending ? "…" : c.ok ? "✓" : "✗"} ${c.evidence}`);
for (const { member, check } of problems(sol, DEMO_SQUAD)) {
  if (check.constraint.kind !== "budget") continue;
  console.log(`\nAsk ${member.name}:`);
  for (const [i, o] of budgetCompromises(pool, DEMO_TRIP, DEMO_SQUAD, sol, member, check.constraint.max).entries())
    console.log(`  ${String.fromCharCode(65 + i)}: ${o.label} → ${formatINR(o.total ?? 0)}${o.stillOver ? ` (still ${formatINR(o.stillOver)} over)` : ""}${o.affects.length ? ` · changes it for ${o.affects.join(", ")}` : ""}`);
}
console.log(`\nsearches ${pool.receipts.length} (${pool.receipts.filter((r) => r.source === "live").length} live)`);
