import { existsSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { closeRenderer, renderCard } from "../src/cards/render.js";
import { buildSampleCards } from "./support/sample-cards.js";

// Renders every card from real search data and never spends a search:
// the local cache (offline, misses fail) or, on a fresh clone, the recorded demo data.
const haveCache = existsSync(".cache/serpapi");
if (haveCache) {
  process.env.SERPAPI_API_KEY ||= "offline-test";
  process.env.SERPAPI_OFFLINE = "true";
} else process.env.DEMO_MODE = "true";
const haveData = haveCache || existsSync("demo-data/serpapi");

afterAll(() => closeRenderer());

test.skipIf(!haveData)("every card renders as a valid PNG without overflowing 1080 px", { timeout: 180_000 }, async () => {
  const cards = await buildSampleCards();
  expect(cards.length).toBeGreaterThanOrEqual(10);
  for (const [name, html, withoutMap] of cards) {
    const r = await renderCard(html, withoutMap);
    expect(r.scrollWidth, `${name} overflows`).toBeLessThanOrEqual(1080);
    expect(r.png.subarray(0, 8).toString("hex"), `${name} is not a PNG`).toBe("89504e470d0a1a0a");
    expect(r.width).toBe(2160);
    expect(r.height).toBeGreaterThan(200);
    expect(r.width + r.height, `${name} too big for Telegram`).toBeLessThan(10_000);
  }
});
