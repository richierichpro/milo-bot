import { rm } from "node:fs/promises";
import { beforeAll, expect, test } from "vitest";
import { useRecordedData } from "./support/offline.js";

const haveData = useRecordedData();

beforeAll(async () => {
  process.env.MILO_DATA_DIR = ".data-test";
  await rm(".data-test", { recursive: true, force: true });
});

test.skipIf(!haveData)("listening extracts every limit from the demo chat and spots 'plan it'", { timeout: 60_000 }, async () => {
  const { createMilo } = await import("../src/bot/index.js");
  const { FakeTelegram, FAKE_BOT } = await import("../src/bot/fake.js");
  const { loadState } = await import("../src/bot/state.js");
  const { DEMO_CHAT } = await import("../src/core/demo.js");

  const tg = new FakeTelegram(-2002);
  const { bot, milo } = createMilo("0:test", { botInfo: FAKE_BOT, quietMs: 60_000 });
  bot.api.config.use(tg.transformer());
  let planNow = false;
  milo.hooks.onPlanNow = async () => {
    planNow = true;
  };
  const who = (n: string) => ({ id: { Aarav: 1001, Meera: 1002, Kabir: 1003, Ishita: 1004 }[n]!, name: n });

  await tg.addBot(bot, who("Aarav"));
  await tg.tap(bot, who("Aarav"), "plan_trip");
  for (const m of DEMO_CHAT) await tg.say(bot, who(m.from), m.text);
  await milo.flushAll();

  const s = await loadState(-2002);
  const get = (n: string) => s.squad.find((p) => p.name === n)!.constraints;
  expect(get("Aarav")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "budget", max: 20000, hard: true }), expect.objectContaining({ kind: "must_do", hard: false })]));
  expect(get("Aarav").find((c) => c.kind === "must_do")).toMatchObject({ what: expect.stringMatching(/chapora/i) });
  expect(get("Meera")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "food", diet: "veg", hard: true })]));
  expect(get("Meera").some((c) => !c.hard && "what" in c && /beach/i.test(c.what))).toBe(true);
  expect(get("Kabir")).toEqual([expect.objectContaining({ kind: "flight_time", direction: "out", date: "2026-11-20", notBefore: "18:00", hard: true })]);
  expect(get("Ishita")).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "budget", max: 15000, hard: true }), expect.objectContaining({ kind: "flight_time", notBefore: "08:00", hard: true })]),
  );
  expect(planNow).toBe(true);
  // Nothing anyone typed is stored.
  expect(JSON.stringify(s)).not.toMatch(/broke this month|office till 6 on friday 😭/);
  // 👀 on the four messages that carried limits.
  expect(tg.sent.filter((x) => x.method === "setMessageReaction")).toHaveLength(4);
});
