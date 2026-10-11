import { existsSync } from "node:fs";

/**
 * Tests never spend credits: with a local cache they read it offline (misses fail);
 * on a fresh clone they use the recorded demo data.
 */
export function useRecordedData(): boolean {
  const cache = existsSync(".cache/serpapi") && existsSync(".cache/claude");
  if (cache) {
    process.env.SERPAPI_API_KEY ||= "offline-test";
    process.env.ANTHROPIC_API_KEY ||= "offline-test";
    process.env.SERPAPI_OFFLINE = "true";
    process.env.CLAUDE_OFFLINE = "true";
  } else process.env.DEMO_MODE = "true";
  process.env.MILO_TODAY = "2026-10-11";
  process.env.MESSAGE_GAP_MS = "0";
  return cache || (existsSync("demo-data/serpapi") && existsSync("demo-data/claude"));
}
