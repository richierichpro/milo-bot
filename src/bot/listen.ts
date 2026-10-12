import { createHash } from "node:crypto";
import { callTool, type ToolDef } from "../core/claude.js";
import type { Constraint, SquadMember } from "../core/types.js";
import type { ChatState } from "./state.js";

// Listening: group messages are buffered and read in one cheap fast-model call
// after 15 s of quiet or 10 messages. Text lives only in this in-memory buffer.

export type Heard = { messageId: number; userId: number; name: string; text: string };

export const BATCH_QUIET_MS = 15_000;
export const BATCH_MAX = 10;

type RawConstraint = {
  person: string;
  kind: Constraint["kind"];
  hard: boolean;
  source_message_id: number;
  max?: number;
  start?: string;
  end?: string;
  diet?: "veg" | "jain" | "vegan" | "no_beef" | "allergy";
  detail?: string;
  direction?: "out" | "back" | "any";
  date?: string;
  not_before?: string;
  not_after?: string;
  what?: string;
  reason?: string;
};

export type Understanding = {
  people: { name: string; city?: string; action: "add" | "remove"; source_message_id: number }[];
  constraints: RawConstraint[];
  trip: { start_date?: string; end_date?: string; interests?: string[] };
  destinations_mentioned: string[];
  intents: { kind: "plan_now" | "edit_request" | "question_to_milo" | "pause"; message_id: number; text?: string }[];
};

const s = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

export const UNDERSTAND: ToolDef = {
  name: "understand_messages",
  description: "Record what these group messages say about who's coming, each person's limits and preferences, and anything asked of Milo.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["people", "constraints", "trip", "destinations_mentioned", "intents"],
    properties: {
      people: {
        type: "array",
        description: "People joining or leaving. A sender who says they're in, or states a limit, is joining.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "action", "source_message_id"],
          properties: {
            name: s("First name as used in the chat"),
            city: s("Home city if stated"),
            action: s("add or remove", { enum: ["add", "remove"] }),
            source_message_id: { type: "integer" },
          },
        },
      },
      constraints: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["person", "kind", "hard", "source_message_id"],
          properties: {
            person: s("Whose limit this is"),
            kind: s("Type of limit", { enum: ["budget", "dates", "food", "flight_time", "must_do", "no_go", "vibe"] }),
            hard: { type: "boolean", description: "true for budget caps, availability, food needs and flight time limits; false for preferences" },
            source_message_id: { type: "integer" },
            max: { type: "integer", description: "budget: rupees per person for the whole trip (15k = 15000)" },
            start: s("dates: first free day, YYYY-MM-DD"),
            end: s("dates: last free day, YYYY-MM-DD"),
            diet: s("food", { enum: ["veg", "jain", "vegan", "no_beef", "allergy"] }),
            detail: s("food: allergy details"),
            direction: s("flight_time: out = to the trip, back = home, any = both", { enum: ["out", "back", "any"] }),
            date: s("flight_time: the one day it applies, YYYY-MM-DD, if limited to a day"),
            not_before: s("flight_time: earliest departure HH:MM, 24h"),
            not_after: s("flight_time: latest departure HH:MM, 24h"),
            what: s("must_do / no_go / vibe: short phrase in their words"),
            reason: s("flight_time: why, in a few words from the message"),
          },
        },
      },
      trip: {
        type: "object",
        additionalProperties: false,
        properties: {
          start_date: s("YYYY-MM-DD if the group's dates are stated"),
          end_date: s("YYYY-MM-DD"),
          interests: { type: "array", items: { type: "string" }, description: "e.g. beaches, food, nightlife" },
        },
      },
      destinations_mentioned: { type: "array", items: { type: "string" }, description: "Place names proposed as where to go" },
      intents: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "message_id"],
          properties: {
            kind: s("plan_now = asks Milo to start planning", { enum: ["plan_now", "edit_request", "question_to_milo", "pause"] }),
            message_id: { type: "integer" },
            text: s("The request, briefly"),
          },
        },
      },
    },
  },
};

const SYSTEM = `You read a friend group's trip chat for Milo, a trip-planning bot. Extract only what is said; never guess.
- Hard limits: budget caps, availability dates, food needs (veg/jain/vegan/allergies), flight time limits. Preferences (a must-see, a vibe, things to avoid) are soft.
- "office till 6 on friday" means their flight to the trip can't leave before 18:00 on that Friday: flight_time, direction out, date = that Friday, not_before 18:00.
- "no flights before 8am" means flight_time, direction any, not_before 08:00.
- "15k max" / "budget 20k" are rupees per person for the whole trip.
- Resolve weekdays and dates using today's date and any trip dates in the messages.
- A place proposed as where to go goes in destinations_mentioned, not in constraints.
- A home city (people[].city) only comes from words like "from", "flying from", "based in", "I live in", "coming from". A place someone wants to visit is NEVER their home city, and someone's home city is NEVER a destination.
- Use the sender's name for "I"/"me". Return empty arrays when nothing applies.`;

export async function understand(messages: Heard[], state: ChatState, today: string, fixFor?: string): Promise<Understanding> {
  const squad = state.squad.map((p) => `${p.name}${p.city ? ` (${p.city})` : ""}`).join(", ") || "nobody yet";
  const known = state.trip.startDate ? `Trip dates so far: ${state.trip.startDate} to ${state.trip.endDate}.` : "No trip dates yet.";
  const lines = messages.map((m) => `#${m.messageId} ${m.name}: ${m.text}`).join("\n");
  const fix = fixFor
    ? `\n\nThis message is ${fixFor}'s correction to their own limits. Put everything in it as constraints for ${fixFor} (a place or thing they want to do or eat is a must_do; something they won't do is a no_go). A new home city goes in people[] for ${fixFor}. Don't fill trip or destinations_mentioned.`
    : "";
  return callTool<Understanding>(SYSTEM, [{ role: "user", content: `Today is ${today}. Squad so far: ${squad}. ${known}\n\nMessages:\n${lines}${fix}` }], UNDERSTAND, {
    fast: true,
    maxTokens: 2000,
    strict: false,
  }).then(normalizeUnderstanding);
}

/** Without strict mode, make sure every list exists and drop malformed entries. */
function normalizeUnderstanding(u: Partial<Understanding>): Understanding {
  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return {
    people: arr<Understanding["people"][number]>(u.people).filter((p) => typeof p?.name === "string" && Number.isInteger(p.source_message_id)),
    constraints: arr<RawConstraint>(u.constraints).filter((c) => typeof c?.person === "string" && typeof c.kind === "string" && Number.isInteger(c.source_message_id)),
    trip: u.trip && typeof u.trip === "object" ? u.trip : {},
    destinations_mentioned: arr<string>(u.destinations_mentioned).filter((d) => typeof d === "string"),
    intents: arr<Understanding["intents"][number]>(u.intents).filter((i) => typeof i?.kind === "string"),
  };
}

// ---------- Applying what was understood ----------

const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
const cid = (memberId: string, c: RawConstraint) => `${memberId}-${c.kind}-${createHash("sha1").update(JSON.stringify(c)).digest("hex").slice(0, 6)}`;

function toConstraint(memberId: string, c: RawConstraint): Constraint | undefined {
  const base = { id: cid(memberId, c), hard: c.hard, sourceMessageId: c.source_message_id };
  switch (c.kind) {
    case "budget":
      return c.max ? { ...base, kind: "budget", max: c.max, hard: true } : undefined;
    case "dates":
      return c.start && c.end ? { ...base, kind: "dates", start: c.start, end: c.end, hard: true } : undefined;
    case "food":
      return c.diet ? { ...base, kind: "food", diet: c.diet, detail: c.detail, hard: true } : undefined;
    case "flight_time":
      return c.not_before || c.not_after
        ? { ...base, kind: "flight_time", hard: true, direction: c.direction ?? "any", date: c.date, notBefore: c.not_before, notAfter: c.not_after, reason: c.reason }
        : undefined;
    case "must_do":
    case "no_go":
    case "vibe":
      return c.what ? { ...base, kind: c.kind, what: c.what, hard: false } : undefined;
  }
}

/** Same kind of limit replaces the old one (a new budget replaces the old budget); preferences accumulate. */
function sameSlot(a: Constraint, b: Constraint): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "budget" || a.kind === "dates") return true;
  if (a.kind === "food" && b.kind === "food") return a.diet === b.diet;
  if (a.kind === "flight_time" && b.kind === "flight_time") return a.direction === b.direction && a.date === b.date;
  if ("what" in a && "what" in b) return a.what.toLowerCase() === b.what.toLowerCase();
  return false;
}

export type Applied = {
  /** Message ids that produced something (they get a 👀). */
  sourceIds: number[];
  /** Friends added by someone else, for the "Added Kabir · Undo" message. */
  addedByOthers: { member: SquadMember; by: string }[];
  intents: Understanding["intents"];
};

export function apply(state: ChatState, u: Understanding, messages: Heard[]): Applied {
  const senderOf = new Map(messages.map((m) => [m.messageId, m]));
  const find = (name: string) => state.squad.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const sourceIds = new Set<number>();
  const addedByOthers: Applied["addedByOthers"] = [];

  const ensure = (name: string, msgId: number, city?: string): SquadMember => {
    const existing = find(name);
    if (existing) {
      if (city && !existing.city) existing.city = city;
      return existing;
    }
    const sender = senderOf.get(msgId);
    const isSender = sender && sender.name.toLowerCase() === name.trim().toLowerCase();
    const member: SquadMember = {
      id: isSender ? String(sender!.userId) : `name:${slug(name)}`,
      name: name.trim().replace(/^./, (c) => c.toUpperCase()),
      city,
      telegramUserId: isSender ? sender!.userId : undefined,
      proxyFor: !isSender && sender ? String(sender.userId) : undefined,
      constraints: [],
    };
    state.squad.push(member);
    if (!isSender && sender) addedByOthers.push({ member, by: sender.name });
    return member;
  };

  for (const p of u.people) {
    if (p.action === "remove") {
      state.squad = state.squad.filter((m) => m.name.toLowerCase() !== p.name.trim().toLowerCase());
    } else ensure(p.name, p.source_message_id, p.city);
    sourceIds.add(p.source_message_id);
  }
  for (const raw of u.constraints) {
    const member = ensure(raw.person, raw.source_message_id);
    const c = toConstraint(member.id, raw);
    if (!c) continue;
    member.constraints = [...member.constraints.filter((x) => !sameSlot(x, c)), c];
    sourceIds.add(raw.source_message_id);
  }
  if (u.trip.start_date && u.trip.end_date) {
    state.trip.startDate = u.trip.start_date;
    state.trip.endDate = u.trip.end_date;
  }
  for (const i of u.trip.interests ?? []) if (!state.trip.interests.includes(i)) state.trip.interests.push(i);
  for (const d of u.destinations_mentioned) if (!state.mentioned.some((m) => m.toLowerCase() === d.toLowerCase())) state.mentioned.push(d);
  sanitize(state);
  return { sourceIds: [...sourceIds], addedByOthers, intents: u.intents };
}

/**
 * Safety net for misreadings: nobody's home city is a place to go, and nobody
 * flies "from" the destination (that person gets asked for their city instead).
 */
export function sanitize(state: ChatState) {
  const lower = (x?: string) => x?.trim().toLowerCase();
  const homes = new Set(state.squad.map((p) => lower(p.city)).filter(Boolean));
  const dest = lower(state.trip.destination);
  const wanted = new Set([dest, ...state.mentioned.map(lower)].filter(Boolean));
  for (const p of state.squad) if (p.city && wanted.has(lower(p.city)) && (dest === lower(p.city) || state.mentioned.length === 1)) p.city = undefined;
  const homesNow = new Set(state.squad.map((p) => lower(p.city)).filter(Boolean));
  state.mentioned = state.mentioned.filter((m) => !homesNow.has(lower(m)));
  if (dest && homesNow.has(dest)) state.trip.destination = undefined;
  void homes;
}

/** Enough to start planning: two or more people and a place or dates. */
export const enoughToPlan = (s: ChatState) => s.squad.length >= 2 && (s.mentioned.length > 0 || !!s.trip.startDate);
