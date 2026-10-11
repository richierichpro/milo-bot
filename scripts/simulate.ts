// Runs the demo through Milo's real handlers with a fake Telegram, using only the
// natural-language chat and button taps, and prints the conversation.
import { createMilo } from "../src/bot/index.js";
import { FakeTelegram, FAKE_BOT, type Sent } from "../src/bot/fake.js";
import { loadState } from "../src/bot/state.js";
import { DEMO_CHAT } from "../src/core/demo.js";

process.env.MILO_TODAY ??= "2026-10-11";
process.env.MESSAGE_GAP_MS ??= "0";
process.env.SERPAPI_OFFLINE ??= process.env.DEMO_MODE === "true" ? "false" : "true";

const people: Record<string, { id: number; name: string }> = Object.fromEntries(
  ["Aarav", "Meera", "Kabir", "Ishita"].map((n, i) => [n, { id: 1001 + i, name: n }]),
);
const tg = new FakeTelegram();
const { bot, milo } = createMilo("0:sim", { botInfo: FAKE_BOT, quietMs: 60_000 });
bot.api.config.use(tg.transformer());

const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
let shown = 0;
function print() {
  for (const s of tg.sent.slice(shown) as Sent[]) {
    const p = s.payload;
    const buttons = (p.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined)?.inline_keyboard?.flat().map((b) => `[${b.text}]`).join(" ");
    if (s.method === "sendMessage") console.log(`🤖 Milo: ${strip(String(p.text)).replace(/\n/g, "\n          ")}${buttons ? `\n          ${buttons}` : ""}`);
    else if (s.method === "editMessageText") console.log(`🤖 (edits msg ${p.message_id}) ${strip(String(p.text)).split("\n")[0]}…`);
    else if (s.method === "setMessageReaction") console.log(`🤖 reacts 👀 to msg ${p.message_id}`);
    else if (s.method === "sendPhoto" || s.method === "sendMediaGroup") console.log(`🤖 [${s.method === "sendPhoto" ? "card" : `album of ${(p.media as unknown[]).length} cards`}] ${strip(String(p.caption ?? (p.media as { caption?: string }[])?.[0]?.caption ?? ""))}`);
    else if (s.method === "answerCallbackQuery" && p.text) console.log(`   (pop-up: ${p.text})`);
    else if (s.method === "pinChatMessage") console.log(`🤖 pins the Trip card`);
  }
  shown = tg.sent.length;
}

const user = (name: string) => people[name];
console.log("— Aarav adds Milo to the group —");
await tg.addBot(bot, user("Aarav"));
print();
console.log("\n— Aarav taps [Plan a trip ✈️] —");
await tg.tap(bot, user("Aarav"), "plan_trip");
print();
console.log("\n— The chat —");
for (const line of DEMO_CHAT) {
  console.log(`👤 ${line.from}: ${line.text}`);
  await tg.say(bot, user(line.from), line.text);
}
await milo.flushAll();
print();

const state = await loadState(tg.chatId);
console.log("\n— What Milo stored (constraints only, no message text) —");
for (const p of state.squad) console.log(`${p.name}${p.city ? ` (${p.city})` : ""}: ${p.constraints.map((c) => `${c.hard ? "🔒" : ""}${c.kind}${"max" in c ? ` ${c.max}` : ""}${"diet" in c ? ` ${c.diet}` : ""}${"notBefore" in c && c.notBefore ? ` ≥${c.notBefore}${c.date ? ` on ${c.date}` : ""}` : ""}${"what" in c ? ` "${c.what}"` : ""}`).join(", ")}`);
console.log(`trip ${JSON.stringify(state.trip)} · mentioned ${state.mentioned.join(", ")} · stage ${state.stage}`);
