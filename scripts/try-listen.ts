// Reads the demo chat with the fast model and prints what Milo heard.
import { apply, understand, type Heard } from "../src/bot/listen.js";
import { freshState } from "../src/bot/state.js";
import { DEMO_CHAT } from "../src/core/demo.js";

const ids: Record<string, number> = { Aarav: 1001, Meera: 1002, Kabir: 1003, Ishita: 1004 };
const msgs: Heard[] = DEMO_CHAT.map((m, i) => ({ messageId: 101 + i, userId: ids[m.from], name: m.from, text: m.text }));
const state = freshState(-1);
const u = await understand(msgs, state, "2026-10-11");
const applied = apply(state, u, msgs);
for (const p of state.squad) {
  console.log(`${p.name}${p.city ? ` (${p.city})` : ""} [${p.id}]`);
  for (const c of p.constraints) console.log(`   ${c.hard ? "HARD" : "soft"} ${JSON.stringify({ ...c, id: undefined, hard: undefined })}`);
}
console.log("trip:", JSON.stringify(state.trip), "| mentioned:", state.mentioned.join(", "));
console.log("intents:", JSON.stringify(applied.intents), "| 👀 on:", applied.sourceIds.join(","));
