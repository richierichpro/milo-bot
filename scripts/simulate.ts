// Runs the demo through Milo's real handlers with a fake Telegram, using only the
// natural-language chat and button taps, and prints the conversation.
import { createMilo } from "../src/bot/index.js";
import { FakeTelegram, FAKE_BOT, type Sent } from "../src/bot/fake.js";
import { loadState } from "../src/bot/state.js";
import { DEMO_CHAT } from "../src/core/demo.js";
import { closeRenderer } from "../src/cards/render.js";

process.env.MILO_TODAY ??= "2026-10-11";
// Keep the simulator's fake chat away from the real bot's .data/.
process.env.MILO_DATA_DIR ??= ".data-sim";
process.env.MESSAGE_GAP_MS ??= "0";
process.env.SERPAPI_OFFLINE ??= process.env.DEMO_MODE === "true" ? "false" : "true";

const people: Record<string, { id: number; name: string }> = Object.fromEntries(
  ["Aarav", "Meera", "Kabir", "Ishita"].map((n, i) => [n, { id: 1001 + i, name: n }]),
);
const tg = new FakeTelegram();
const { bot, milo, flow, edits } = createMilo("0:sim", { botInfo: FAKE_BOT, quietMs: 60_000 });
bot.api.config.use(tg.transformer());

const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, "\"");
let shown = 0;
function print() {
  for (const s of tg.sent.slice(shown) as Sent[]) {
    const p = s.payload;
    const buttons = (p.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined)?.inline_keyboard?.flat().map((b) => `[${b.text}]`).join(" ");
    if (s.method === "sendMessage") console.log(`🤖 Milo: ${strip(String(p.text)).replace(/\n/g, "\n          ")}${buttons ? `\n          ${buttons}` : ""}`);
    else if (s.method === "editMessageText") console.log(`🤖 (edits msg ${p.message_id}) ${strip(String(p.text)).split("\n")[0]}…`);
    else if (s.method === "editMessageCaption") console.log(`🤖 (updates card ${p.message_id}) ${strip(String(p.caption)).replace(/\n/g, "\n          ")}`);
    else if (s.method === "deleteMessage") console.log(`🤖 (deletes msg ${p.message_id})`);
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

// Buttons Milo sent, newest first.
function buttons(): { data: string; text: string; messageId?: number }[] {
  const out: { data: string; text: string; messageId?: number }[] = [];
  for (let i = tg.sent.length - 1; i >= 0; i--) {
    const s = tg.sent[i];
    const kb = (s.payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard;
    for (const b of kb?.flat() ?? []) if (b.callback_data) out.push({ data: b.callback_data, text: b.text, messageId: s.messageId ?? (s.payload.message_id as number) });
  }
  return out;
}
const tapButton = async (who: string, match: (b: { data: string; text: string }) => boolean, say?: string) => {
  const b = buttons().find(match);
  if (!b) throw new Error(`No button for ${who}`);
  console.log(`👆 ${who} taps [${b.text}]${say ? ` ${say}` : ""}`);
  await tg.tap(bot, user(who), b.data, b.messageId);
  print();
};

const homes: Record<string, string> = { Aarav: "Hyderabad", Meera: "Bengaluru", Kabir: "Delhi", Ishita: "Pune" };
for (let i = 0; i < 16; i++) {
  const st = await loadState(tg.chatId);
  const q = (st.data as { question?: { memberId: string; kind: string; pending?: string[] } }).question;
  if (!q) break;
  if (q.memberId === "all") {
    // One group question: budgets are typed, food is a tap.
    const who = st.squad.find((p) => p.id === q.pending![0])!.name;
    if (q.kind === "budget") {
      console.log(`💬 ${who}: no limit`);
      await tg.say(bot, user(who), "no limit");
      print();
    } else await tapButton(who, (b) => b.data === (who === "Kabir" ? "q:all:nonveg" : "q:all:none"));
    continue;
  }
  const who = st.squad.find((p) => p.id === q.memberId)!.name;
  // Cities from the demo squad; nobody else has a budget cap or food needs.
  const answer = q.kind === "city" ? homes[who] : "none";
  await tapButton(who, (b) => b.data === `q:${q.memberId}:${answer}`);
}

console.log("\n— Everyone's details, once all questions are answered —");
console.log("\n— Meera tries to fix Kabir's row —");
await tapButton("Meera", (b) => b.data.startsWith("fix:") && b.text.includes("Kabir"));
console.log("\n— Aarav confirms —");
await tapButton("Aarav", (b) => b.data === "heard_ok");

console.log("\n— The vote —");
for (const who of ["Aarav", "Meera", "Kabir", "Ishita"]) {
  const st = await loadState(tg.chatId);
  if ((st.data as { vote?: { status: string } }).vote?.status === "closed") break;
  await tapButton(who, (b) => b.data.startsWith("v:") && / · Goa · /.test(b.text));
}

console.log("\n— Solving within everyone's limits —");
for (let i = 0; i < 6; i++) {
  const st = await loadState(tg.chatId);
  const sv = st.data.solve as { asking?: { memberId: string }; quick?: { status: string }; hotelVote?: { done?: boolean; votes: Record<string, number> } } | undefined;
  if (sv?.hotelVote && !sv.hotelVote.done) {
    // The group picks the stay: three of four tap A, Ishita taps B.
    for (const [who, pick] of [["Aarav", 0], ["Meera", 0], ["Ishita", 1], ["Kabir", 0]] as const) {
      const now = (await loadState(tg.chatId)).data.solve as typeof sv;
      if (now?.hotelVote?.done) break;
      await tapButton(who, (b) => b.data.startsWith("hv:") && b.data.endsWith(`:${pick}`));
    }
    continue;
  }
  if (sv?.asking) {
    const who = st.squad.find((p) => p.id === sv.asking!.memberId)!.name;
    await tapButton(who, (b) => b.data === `neg:${sv.asking!.memberId}:0`, "(the option that fits her cap)");
    continue;
  }
  if (sv?.quick?.status === "open") {
    for (const who of ["Aarav", "Meera"]) await tapButton(who, (b) => b.data.startsWith("qv:") && b.data.endsWith(":up"));
    continue;
  }
  break;
}

console.log("\n— After the plan, the chat asks for a change —");
console.log("💬 Kabir: add a spa session on day 3 pls");
await tg.say(bot, user("Kabir"), "add a spa session on day 3 pls");
console.log("💬 Meera: haha yes");
await tg.say(bot, user("Meera"), "haha yes");
await edits.flush(tg.chatId);
print();

const state = await loadState(tg.chatId);
console.log("\n— What Milo stored (constraints only, no message text) —");
for (const p of state.squad) console.log(`${p.name}${p.city ? ` (${p.city})` : ""}: ${p.constraints.map((c) => `${c.hard ? "🔒" : ""}${c.kind}${"max" in c ? ` ${c.max}` : ""}${"diet" in c ? ` ${c.diet}` : ""}${"notBefore" in c && c.notBefore ? ` ≥${c.notBefore}${c.date ? ` on ${c.date}` : ""}` : ""}${"what" in c ? ` "${c.what}"` : ""}`).join(", ")}`);
console.log(`trip ${JSON.stringify(state.trip)} · mentioned ${state.mentioned.join(", ")} · stage ${state.stage}`);

flow.stopClock();
await closeRenderer();
process.exit(0);
