import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SquadMember } from "../core/types.js";

// One JSON file per chat in .data/chats/. Message text is never stored: only
// the limits Milo extracted and the id of the message each came from.

export type Stage = "intro" | "listening" | "heard" | "questions" | "destination_vote" | "solving" | "negotiating" | "planning" | "done";

export type ChatState = {
  chatId: number;
  stage: Stage;
  listening: boolean;
  paused: boolean;
  squad: SquadMember[];
  trip: { destination?: string; startDate?: string; endDate?: string; interests: string[] };
  /** Places people named in the chat, in order. */
  mentioned: string[];
  planItNowSent: boolean;
  tripCard?: { messageId: number; pinned: boolean };
  decisions: string[];
  pending: string[];
  /** Squad adds that can still be undone, by callback token. */
  undo: Record<string, { memberId: string; addedBy: string }>;
  /** Free-form per-step data (votes, questions, plan) added by later steps. */
  data: Record<string, unknown>;
  updatedAt: string;
};

const DIR = () => path.join(process.cwd(), process.env.MILO_DATA_DIR ?? ".data", "chats");
const cache = new Map<number, ChatState>();

export function freshState(chatId: number): ChatState {
  return {
    chatId,
    stage: "intro",
    listening: false,
    paused: false,
    squad: [],
    trip: { interests: [] },
    mentioned: [],
    planItNowSent: false,
    decisions: [],
    pending: [],
    undo: {},
    data: {},
    updatedAt: new Date().toISOString(),
  };
}

export async function loadState(chatId: number): Promise<ChatState> {
  const hit = cache.get(chatId);
  if (hit) return hit;
  let state: ChatState;
  try {
    state = { ...freshState(chatId), ...(JSON.parse(await readFile(path.join(DIR(), `${chatId}.json`), "utf8")) as ChatState) };
  } catch {
    state = freshState(chatId);
  }
  cache.set(chatId, state);
  return state;
}

/** Atomic write: a crash mid-save never leaves a half-written file. */
export async function saveState(state: ChatState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  cache.set(state.chatId, state);
  await mkdir(DIR(), { recursive: true });
  const file = path.join(DIR(), `${state.chatId}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
  await rename(`${file}.tmp`, file);
}

export function resetState(chatId: number): ChatState {
  const s = freshState(chatId);
  cache.set(chatId, s);
  return s;
}
