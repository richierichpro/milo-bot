// Records one full demo run into demo-data/ so Milo runs without API keys, then
// proves it: replays the demo with no keys and fails if anything wasn't recorded.
import { spawnSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const run = (env: Record<string, string>, label: string) => {
  console.log(`\n▶ ${label}`);
  const r = spawnSync("npx", ["tsx", ...(env.NO_ENV_FILE ? [] : ["--env-file=.env.local"]), "scripts/simulate.ts"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...env, MILO_DATA_DIR: ".data-record" },
    encoding: "utf8",
  });
  const out = r.stdout ?? "";
  const tail = out.trim().split("\n").filter((l) => /Decided|check out|Boarding passes|See sources|couldn't|isn't in the demo|No demo data|Error/.test(l));
  console.log(tail.map((l) => `   ${l}`).join("\n"));
  return { ok: r.status === 0 && /See sources/.test(out) && !/No demo data|isn't in the demo recording|couldn't be checked/.test(out), out };
};

await rm("demo-data/serpapi", { recursive: true, force: true });
await rm("demo-data/claude", { recursive: true, force: true });
await rm(".data-record", { recursive: true, force: true });

// 1. Real keys, everything already cached: copies each response used into demo-data/.
const rec = run({ RECORD_DEMO: "true", SERPAPI_OFFLINE: "false" }, "Recording the demo with real keys");
if (!rec.ok) throw new Error("Recording run didn't reach the boarding passes.");

// 2. No keys at all: must replay entirely from demo-data/.
await rm(".data-record", { recursive: true, force: true });
const replay = run({ NO_ENV_FILE: "1", DEMO_MODE: "true", SERPAPI_API_KEY: "", ANTHROPIC_API_KEY: "" }, "Replaying with DEMO_MODE=true and no keys");
if (!replay.ok) throw new Error("Demo replay failed: some search or Claude answer wasn't recorded.");

// 3. No secrets in the recordings.
const env = Object.fromEntries((await readFile(".env.local", "utf8")).split("\n").filter((l) => l.includes("=")).map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
const secrets = [env.SERPAPI_API_KEY, env.ANTHROPIC_API_KEY, env.TELEGRAM_BOT_TOKEN].filter((v) => v && v.length > 8);
const files: string[] = [];
const walk = async (d: string) => {
  for (const f of await readdir(d, { withFileTypes: true })) f.isDirectory() ? await walk(path.join(d, f.name)) : files.push(path.join(d, f.name));
};
await walk("demo-data");
let leaks = 0;
for (const f of files) {
  const text = await readFile(f, "utf8");
  if (/api_key/i.test(text) || secrets.some((s) => text.includes(s))) {
    leaks++;
    console.log(`   ✗ secret-like text in ${f}`);
  }
}
if (leaks) throw new Error(`${leaks} recording(s) contain key material.`);
await writeFile("demo-data/meta.json", JSON.stringify({ recordedAt: new Date().toISOString(), today: "2026-10-11" }, null, 2));
await rm(".data-record", { recursive: true, force: true });
console.log(`\n✓ ${files.length} recordings in demo-data/, replay works with no keys, no secrets found.`);
