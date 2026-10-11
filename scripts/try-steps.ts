// Dry run of the step-by-step setup with a fake Telegram (one organiser adding friends).
import { createMilo } from "../src/bot/index.js";
import { FakeTelegram, FAKE_BOT } from "../src/bot/fake.js";

process.env.MILO_TODAY ??= "2026-10-11";
process.env.MESSAGE_GAP_MS = "0";
process.env.MILO_DATA_DIR = ".data-steps";
const tg = new FakeTelegram(-3003, "Goa 2026");
const { bot, milo, flow } = createMilo("0:sim", { botInfo: FAKE_BOT, quietMs: 60_000 });
bot.api.config.use(tg.transformer());
const me = { id: 5001, name: "Nihal" };
let shown = 0;
const strip = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
const print = () => {
  for (const s of tg.sent.slice(shown)) {
    const kb = (s.payload.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined)?.inline_keyboard?.flat().map((b) => `[${b.text}]`).join(" ");
    if (s.method === "sendMessage") console.log(`🤖 ${strip(String(s.payload.text)).replace(/\n/g, " / ")}${kb ? `  ${kb}` : ""}`);
    if (s.method === "sendPhoto") console.log(`🤖 [card] ${strip(String(s.payload.caption)).split("\n")[0]}`);
  }
  shown = tg.sent.length;
};
const say = async (t: string) => {
  console.log(`👤 Nihal: ${t}`);
  await tg.say(bot, me, t);
  await milo.flushAll();
  print();
};
const tap = async (data: string) => {
  console.log(`👆 Nihal taps ${data}`);
  await tg.tap(bot, me, data);
  print();
};
await tg.addBot(bot, me);
print();
await tap("plan_trip");
await say("I'm in, flying from Hyderabad. Meera from Bengaluru is in too, she's veg");
await tap("setup:next");
await say("goa!");
await tap("setup:when:next_weekend");
flow.stopClock();
process.exit(0);
