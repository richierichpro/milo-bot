import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

export const model = () => process.env.CLAUDE_MODEL || "claude-haiku-5-5";
/** Cheaper settings for reading chat messages. */
export const fastModel = () => process.env.CLAUDE_MODEL_FAST || process.env.CLAUDE_MODEL || "claude-haiku-5-5";

export type CallOptions = {
  fast?: boolean;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  /** Strict schemas guarantee shape but have a complexity limit; big optional-heavy schemas turn it off and validate in code. */
  strict?: boolean;
};

export type ToolDef = Anthropic.Tool;

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

const CACHE_DIR = path.join(process.cwd(), ".cache", "claude");
const DEMO_DIR = path.join(process.cwd(), "demo-data", "claude");

export const DEMO_MISSING = "This edit isn't in the demo recording. Add an ANTHROPIC_API_KEY to try your own.";

export function isClaudeDemo(): boolean {
  return process.env.DEMO_MODE === "true" || !process.env.ANTHROPIC_API_KEY;
}

const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex");

/**
 * Demo recordings are keyed without the model, so they replay whatever
 * CLAUDE_MODEL a judge has set. Our requests contain no timestamps or
 * "checked N min ago" text, so the same request always has the same key.
 */
const demoKey = (params: CreateParams) => hash({ ...params, model: undefined });

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

/**
 * Every Claude call goes through here. Responses are saved to disk keyed by a
 * hash of the request, so the same request never costs twice. In demo mode
 * answers come only from demo-data/claude/.
 */
async function create(params: CreateParams): Promise<Anthropic.Message> {
  const demoFile = path.join(DEMO_DIR, `${demoKey(params)}.json`);
  if (isClaudeDemo()) {
    const recorded = await readJson<Anthropic.Message>(demoFile);
    if (!recorded) throw new Error(DEMO_MISSING);
    return recorded;
  }
  const file = path.join(CACHE_DIR, `${hash(params)}.json`);
  // As with searches, a recorded answer to the same request is reused before calling the API.
  // MILO_FRESH=true: always ask Claude; the answer is still saved.
  let res = process.env.MILO_FRESH === "true" ? null : await readJson<Anthropic.Message>(file);
  if (!res) {
    // Tests run with CLAUDE_OFFLINE=true: a cache miss fails instead of spending tokens.
    if (process.env.CLAUDE_OFFLINE === "true") throw new Error("Offline and not cached: Claude request");
    res = await getClient().messages.create(params);
    // A cut-off answer (max_tokens) is never reused: the retry must reach the API.
    if (res.stop_reason !== "refusal" && res.stop_reason !== "max_tokens") await writeJson(file, res);
  }
  if (process.env.RECORD_DEMO === "true") await writeJson(demoFile, res);
  return res;
}

/**
 * Makes Claude answer through one tool and returns that tool's input.
 * Current models reject a forced tool_choice, so we use "auto" with a strict
 * schema, tell Claude to call the tool, and nudge once if it answers in text.
 */
export async function callTool<T>(system: string, messages: Anthropic.MessageParam[], tool: ToolDef, opts: CallOptions = {}): Promise<T> {
  let maxTokens = opts.maxTokens ?? 8000;
  const request = (msgs: Anthropic.MessageParam[]) =>
    create({
      model: opts.fast ? fastModel() : model(),
      max_tokens: maxTokens,
      // Stable instructions first and marked cacheable, so repeat calls pay ~10% for them.
      system: [{ type: "text", text: `${system}\n\nAnswer only by calling the ${tool.name} tool.`, cache_control: { type: "ephemeral" } }],
      messages: msgs,
      tools: [{ ...tool, strict: opts.strict ?? true }],
      tool_choice: { type: "auto" },
      output_config: { effort: opts.effort ?? (opts.fast ? "low" : "medium") },
    });

  let res = await request(messages);
  // Cut off mid-answer: ask again once with twice the room.
  if (res.stop_reason === "max_tokens") {
    maxTokens = Math.min(maxTokens * 2, 32_000);
    res = await request(messages);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off.");
    if (res.stop_reason === "refusal") throw new Error("Claude declined this request.");
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === tool.name);
    if (call) return call.input as T;
    if (attempt === 1) break;
    res = await request([
      ...messages,
      { role: "assistant", content: res.content },
      { role: "user", content: `Please answer by calling the ${tool.name} tool.` },
    ]);
  }
  throw new Error(`Claude didn't call ${tool.name}.`);
}

/** Raw access for the chat agent's tool loop (Step 7). */
export function createMessage(params: Omit<CreateParams, "model">) {
  return create({ model: model(), ...params });
}
