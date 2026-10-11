/* eslint-disable @typescript-eslint/no-explicit-any -- raw SerpApi JSON is parsed here */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallLogEntry } from "./types.js";

export type SerpParams = Record<string, string | number | boolean | undefined>;

const ENDPOINT = "https://serpapi.com/search.json";
const TIMEOUT_MS = 30_000;
const CACHE_DIR = path.join(process.cwd(), ".cache", "serpapi");
const DEMO_DIR = path.join(process.cwd(), "demo-data", "serpapi");

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true" || !process.env.SERPAPI_API_KEY;
}

/** scripts/record-demo.ts sets this to copy every response it uses into demo-data/. */
const isRecording = () => process.env.RECORD_DEMO === "true";

async function recordForDemo(params: SerpParams, json: unknown) {
  if (!isRecording()) return;
  const file = cachePath(params, true);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(json));
}

/** Params without api_key or empty values, sorted by name. */
function cleanParams(params: SerpParams): [string, string][] {
  return Object.entries(params)
    .filter(([k, v]) => k !== "api_key" && v !== undefined && v !== "")
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}

export function cacheKey(params: SerpParams): string {
  return createHash("sha1").update(JSON.stringify(cleanParams(params))).digest("hex");
}

export function cachePath(params: SerpParams, demo = false): string {
  const engine = String(params.engine ?? "unknown");
  return path.join(demo ? DEMO_DIR : CACHE_DIR, engine, `${cacheKey(params)}.json`);
}

function summarize(params: SerpParams): string {
  if (params.q) return String(params.q);
  if (params.departure_id && params.arrival_id) return `${params.departure_id} → ${params.arrival_id}`;
  if (params.departure_id) return `from ${params.departure_id}`;
  return String(params.engine);
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Remove anything that could carry the key before it is cached or returned. */
function scrub(json: any): any {
  if (json && typeof json === "object") {
    const meta = json.search_metadata;
    if (meta) {
      delete meta.json_endpoint;
      delete meta.raw_html_file;
    }
    const sp = json.search_parameters;
    if (sp) delete sp.api_key;
  }
  return json;
}

function checkError(engine: string, json: any) {
  if (json && typeof json === "object" && json.error) {
    // "Hasn't returned any results" is a valid empty answer, not a failure.
    if (/hasn't returned any results/i.test(String(json.error))) return;
    throw new Error(`SerpApi ${engine}: ${json.error}`);
  }
}

export async function serpSearch(params: SerpParams, opts?: { log?: CallLogEntry[] }): Promise<any> {
  const engine = String(params.engine ?? "unknown");
  const started = Date.now();
  const record = (source: CallLogEntry["source"]) =>
    opts?.log?.push({ engine, summary: summarize(params), source, ms: Date.now() - started, at: new Date().toISOString() });

  if (isDemoMode()) {
    const json = await readJson(cachePath(params, true));
    if (!json) throw new Error(`No demo data for this search: ${engine} ${summarize(params)}`);
    checkError(engine, json);
    record("demo");
    return json;
  }

  const cacheFile = cachePath(params);
  // A fresh server (e.g. a deploy) has no .cache yet; the committed demo
  // recordings are real responses too, so use them before paying for a search.
  // MILO_FRESH=true (e.g. recording a demo): every search goes to SerpApi; results are still saved.
  const cached = process.env.MILO_FRESH === "true" ? null : await readJson(cacheFile);
  if (cached) {
    checkError(engine, cached);
    await recordForDemo(params, cached);
    record("cache");
    return cached;
  }

  // Tests and the simulator run with SERPAPI_OFFLINE=true: a cache miss fails instead of spending a search.
  if (process.env.SERPAPI_OFFLINE === "true") throw new Error(`Offline and not cached: ${engine} ${summarize(params)}`);

  const url = new URL(ENDPOINT);
  for (const [k, v] of cleanParams(params)) url.searchParams.set(k, v);
  url.searchParams.set("api_key", process.env.SERPAPI_API_KEY!);

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`SerpApi ${engine}: request failed (${(err as Error).name})`);
  }
  const json = scrub(await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
  checkError(engine, json);
  if (!res.ok) throw new Error(`SerpApi ${engine}: HTTP ${res.status}`);

  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(json));
  await recordForDemo(params, json);
  record("live");
  return json;
}
