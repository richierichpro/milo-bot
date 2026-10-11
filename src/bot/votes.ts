import type { SquadMember } from "../core/types.js";

// Every voting rule from CLAUDE.md as pure functions, so they're testable with a fake clock.

export type VoteOption = {
  key: string;
  label: string;
  sub?: string;
  /** Rupees per person, for tie-breaks (cheaper wins). */
  costPerPerson?: number;
  /** Spread of per-person costs, for tie-breaks (fairer wins). */
  fairnessGap?: number;
  /** Members whose hard limit this option breaks: it needs their OK. */
  breaks: string[];
  /** Members who said OK / no to an option that breaks their limit. */
  okBy: string[];
  vetoedBy?: string;
};

export type Vote = {
  id: string;
  question: string;
  options: VoteOption[];
  /** voter member id → option key */
  ballots: Record<string, string>;
  /** Squad member ids that get a vote. */
  eligible: string[];
  createdAt: number;
  deadline: number;
  pingedHalf: boolean;
  extended: boolean;
  status: "open" | "objections" | "closed";
  winner?: string;
  reason?: string;
  /** Tie-break objections window end. */
  objectionsUntil?: number;
  messageId?: number;
};

export const minutes = (n: number) => n * 60_000;
export const VOTE_MIN = () => Number(process.env.VOTE_MIN ?? 120);
export const QUICK_VOTE_MIN = () => Number(process.env.QUICK_VOTE_MIN ?? 15);
export const OBJECTION_MIN = 10;

export function newVote(id: string, question: string, options: Omit<VoteOption, "okBy">[], squad: SquadMember[], now: number): Vote {
  return {
    id,
    question,
    options: options.map((o) => ({ ...o, okBy: [] })),
    ballots: {},
    eligible: squad.map((p) => p.id),
    createdAt: now,
    deadline: now + minutes(VOTE_MIN()),
    pingedHalf: false,
    extended: false,
    status: "open",
  };
}

/** Who a Telegram user can vote for: themselves, then friends they added who aren't on Telegram. */
export function votersFor(telegramUserId: number, squad: SquadMember[]): SquadMember[] {
  const me = squad.find((p) => p.telegramUserId === telegramUserId);
  const proxies = squad.filter((p) => !p.telegramUserId && p.proxyFor === String(telegramUserId));
  return [...(me ? [me] : []), ...proxies];
}

export type CastResult = { ok: boolean; message: string; votedFor?: string };

/**
 * One vote per member. A tap votes for yourself; if you've voted and you added
 * a friend who isn't on Telegram, the next tap votes for them ("Aarav for Kabir").
 * Tapping an option that breaks your own hard limit counts as your OK for it.
 */
export function cast(v: Vote, telegramUserId: number, key: string, squad: SquadMember[]): CastResult {
  if (v.status !== "open") return { ok: false, message: "This vote is closed." };
  const option = v.options.find((o) => o.key === key);
  if (!option || option.vetoedBy) return { ok: false, message: "That option is off the table." };
  const voters = votersFor(telegramUserId, squad);
  if (!voters.length) return { ok: false, message: "Only people in the squad can vote. Tell the group you're in first!" };
  const target = voters.find((p) => !v.ballots[p.id]) ?? voters[0];
  v.ballots[target.id] = key;
  if (option.breaks.includes(target.id) && !option.okBy.includes(target.id)) option.okBy.push(target.id);
  const self = target.telegramUserId === telegramUserId;
  const next = voters.find((p) => !v.ballots[p.id]);
  return {
    ok: true,
    votedFor: target.id,
    message: `${self ? "Voted" : `Voted for ${target.name}`}: ${option.label}${next ? `. Tap again to vote for ${next.name}` : ""}`,
  };
}

/** The person whose limit an option breaks says no: it's out, whatever the votes. */
export function veto(v: Vote, memberId: string, key: string): boolean {
  const o = v.options.find((x) => x.key === key);
  if (!o || !o.breaks.includes(memberId)) return false;
  o.vetoedBy = memberId;
  for (const [voter, choice] of Object.entries(v.ballots)) if (choice === key) delete v.ballots[voter];
  return true;
}

export function tally(v: Vote): Map<string, number> {
  const t = new Map(v.options.filter((o) => !o.vetoedBy).map((o) => [o.key, 0]));
  for (const k of Object.values(v.ballots)) if (t.has(k)) t.set(k, t.get(k)! + 1);
  return t;
}

/** An option can win only if everyone whose hard limit it breaks has OK'd it. */
const allowed = (o: VoteOption) => !o.vetoedBy && o.breaks.every((m) => o.okBy.includes(m));

function leaders(v: Vote): VoteOption[] {
  const t = tally(v);
  const live = v.options.filter(allowed);
  const top = Math.max(0, ...live.map((o) => t.get(o.key) ?? 0));
  return live.filter((o) => (t.get(o.key) ?? 0) === top);
}

/** True when the remaining votes can't change who's ahead. */
export function decided(v: Vote): boolean {
  const t = tally(v);
  const remaining = v.eligible.filter((m) => !v.ballots[m]).length;
  const sorted = v.options.filter(allowed).map((o) => t.get(o.key) ?? 0).sort((a, b) => b - a);
  return sorted.length > 0 && sorted[0] > (sorted[1] ?? 0) + remaining;
}

export type VoteEvent =
  | { type: "ping"; memberIds: string[] }
  | { type: "extended"; memberIds: string[] }
  | { type: "tie"; winner: string; reason: string }
  | { type: "closed"; winner: string; reason: string }
  | { type: "no_winner"; reason: string };

function close(v: Vote, winner: VoteOption, reason: string): VoteEvent {
  v.status = "closed";
  v.winner = winner.key;
  v.reason = reason;
  return { type: "closed", winner: winner.key, reason };
}

/** Cheaper first, then fairer: the tie-break rule. */
function tieBreak(options: VoteOption[]): { winner: VoteOption; reason: string } {
  const sorted = [...options].sort((a, b) => (a.costPerPerson ?? Infinity) - (b.costPerPerson ?? Infinity) || (a.fairnessGap ?? Infinity) - (b.fairnessGap ?? Infinity));
  const [w, r] = sorted;
  const why = w.costPerPerson !== undefined && r?.costPerPerson !== undefined && w.costPerPerson !== r.costPerPerson ? "it's cheaper per person" : "it's the fairest split";
  return { winner: w, reason: `Tie between ${options.map((o) => o.label).join(" and ")}: going with ${w.label} because ${why}.` };
}

/** Advance the vote's clock: half-time pings, early close, deadline, quorum extension, tie objections. */
export function tick(v: Vote, now: number): VoteEvent[] {
  const events: VoteEvent[] = [];
  const nonVoters = () => v.eligible.filter((m) => !v.ballots[m]);
  if (v.status === "objections") {
    if (now >= (v.objectionsUntil ?? 0)) events.push(close(v, v.options.find((o) => o.key === v.winner)!, v.reason ?? ""));
    return events;
  }
  if (v.status !== "open") return events;

  const allVoted = nonVoters().length === 0;
  if (allVoted || decided(v)) {
    const lead = leaders(v);
    if (lead.length === 1) return [close(v, lead[0], allVoted ? "Everyone voted." : "The result can't change any more.")];
  }

  const half = v.createdAt + (v.deadline - v.createdAt) / 2;
  if (!v.pingedHalf && now >= half && nonVoters().length) {
    v.pingedHalf = true;
    events.push({ type: "ping", memberIds: nonVoters() });
  }

  if (now >= v.deadline || allVoted) {
    const voted = Object.keys(v.ballots).length;
    if (voted * 2 < v.eligible.length && !v.extended) {
      v.extended = true;
      v.deadline = now + minutes(VOTE_MIN());
      events.push({ type: "extended", memberIds: nonVoters() });
      return events;
    }
    const lead = leaders(v);
    if (!lead.length) {
      v.status = "closed";
      events.push({ type: "no_winner", reason: "No option has everyone's OK." });
    } else if (lead.length === 1) events.push(close(v, lead[0], "Voting closed."));
    else {
      const { winner, reason } = tieBreak(lead);
      v.status = "objections";
      v.winner = winner.key;
      v.reason = reason;
      v.objectionsUntil = now + minutes(OBJECTION_MIN);
      events.push({ type: "tie", winner: winner.key, reason });
    }
  }
  return events;
}

/** "Reopen" needs a majority of the squad. */
export function reopenAllowed(requests: string[], eligible: string[]): boolean {
  return new Set(requests.filter((r) => eligible.includes(r))).size * 2 > eligible.length;
}

// ---------- Quick 👍/👎 for small changes ----------

export type QuickVote = { id: string; up: string[]; down: string[]; eligible: string[]; deadline: number; status: "open" | "passed" | "rejected" };

export const newQuickVote = (id: string, squad: SquadMember[], now: number): QuickVote => ({
  id,
  up: [],
  down: [],
  eligible: squad.map((p) => p.id),
  deadline: now + minutes(QUICK_VOTE_MIN()),
  status: "open",
});

/** Goes through unless a majority votes 👎 before the deadline (a 👍 majority settles it early). */
export function quickTick(q: QuickVote, now: number): QuickVote["status"] {
  if (q.status !== "open") return q.status;
  if (q.down.length * 2 > q.eligible.length) q.status = "rejected";
  else if (q.up.length * 2 > q.eligible.length || now >= q.deadline) q.status = "passed";
  return q.status;
}

/** Button label with live count and voter initials: "Goa · 2 · A M". */
export function buttonLabel(v: Vote, o: VoteOption, squad: SquadMember[], index: number): string {
  const voters = Object.entries(v.ballots)
    .filter(([, k]) => k === o.key)
    .map(([m]) => squad.find((p) => p.id === m)?.name.slice(0, 1) ?? "?");
  return `${String.fromCharCode(65 + index)} · ${o.label}${o.vetoedBy ? " ✗" : ""} · ${voters.length}${voters.length ? ` · ${voters.join(" ")}` : ""}`;
}

/** "Aarav · Meera · Aarav for Kabir" */
export function voterNames(v: Vote, key: string, squad: SquadMember[]): string[] {
  return Object.entries(v.ballots)
    .filter(([, k]) => k === key)
    .map(([m]) => {
      const p = squad.find((x) => x.id === m);
      if (!p) return "?";
      if (!p.telegramUserId && p.proxyFor) return `${squad.find((x) => x.telegramUserId === Number(p.proxyFor))?.name ?? "someone"} for ${p.name}`;
      return p.name;
    });
}
