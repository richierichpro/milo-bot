import { describe, expect, test } from "vitest";
import type { SquadMember } from "../src/core/types.js";
import { cast, decided, minutes, newQuickVote, newVote, quickTick, reopenAllowed, tick, veto, voterNames } from "../src/bot/votes.js";

process.env.VOTE_MIN = "120";
process.env.QUICK_VOTE_MIN = "15";
const m = (name: string, tg?: number, proxyFor?: string): SquadMember => ({ id: tg ? String(tg) : `name:${name.toLowerCase()}`, name, telegramUserId: tg, proxyFor, constraints: [] });
const squad = [m("Aarav", 1), m("Meera", 2), m("Ishita", 4), m("Kabir", undefined, "1")];
const T0 = 1_000_000;
const opts = () => [
  { key: "goa", label: "Goa", costPerPerson: 18000, fairnessGap: 7000, breaks: ["4"] },
  { key: "kochi", label: "Kochi", costPerPerson: 17000, fairnessGap: 9000, breaks: [] },
  { key: "chennai", label: "Chennai", costPerPerson: 17000, fairnessGap: 8000, breaks: [] },
];

describe("votes", () => {
  test("proxy votes: Aarav votes for himself, then for Kabir, shown as 'Aarav for Kabir'", () => {
    const v = newVote("v", "Where?", opts(), squad, T0);
    expect(cast(v, 1, "kochi", squad).message).toBe("Voted: Kochi. Tap again to vote for Kabir");
    expect(cast(v, 1, "kochi", squad).message).toBe("Voted for Kabir: Kochi");
    expect(voterNames(v, "kochi", squad)).toEqual(["Aarav", "Aarav for Kabir"]);
    expect(cast(v, 99, "kochi", squad).ok).toBe(false); // not in the squad
  });

  test("pings non-voters by name at half time", () => {
    const v = newVote("v", "Where?", opts(), squad, T0);
    cast(v, 1, "kochi", squad);
    expect(tick(v, T0 + minutes(59))).toEqual([]);
    expect(tick(v, T0 + minutes(61))).toEqual([{ type: "ping", memberIds: ["2", "4", "name:kabir"] }]);
    expect(tick(v, T0 + minutes(62))).toEqual([]); // only once
  });

  test("closes early when everyone has voted, or when the result can't change", () => {
    const v = newVote("v", "Where?", opts(), squad, T0);
    for (const [tg, k] of [[1, "kochi"], [1, "kochi"], [2, "kochi"]] as const) cast(v, tg, k, squad);
    expect(decided(v)).toBe(true); // 3 of 4 for Kochi; 1 left can't change it
    expect(tick(v, T0 + 1)).toEqual([{ type: "closed", winner: "kochi", reason: "The result can't change any more." }]);
  });

  test("tie → cheaper/fairer option wins, with a 10-minute objection window", () => {
    const v = newVote("v", "Where?", opts(), squad, T0);
    cast(v, 1, "kochi", squad);
    cast(v, 1, "chennai", squad); // Kabir
    cast(v, 2, "kochi", squad);
    cast(v, 4, "chennai", squad);
    const [ev] = tick(v, T0 + 1);
    expect(ev).toMatchObject({ type: "tie", winner: "chennai" }); // same price, fairer split
    expect(v.status).toBe("objections");
    expect(tick(v, T0 + minutes(5))).toEqual([]);
    expect(tick(v, T0 + minutes(11))[0]).toMatchObject({ type: "closed", winner: "chennai" });
  });

  test("under half voted at the deadline → extend once and ping", () => {
    const v = newVote("v", "Where?", opts(), squad, T0);
    cast(v, 2, "kochi", squad);
    const evs = tick(v, T0 + minutes(121));
    expect(evs.at(-1)).toEqual({ type: "extended", memberIds: ["1", "4", "name:kabir"] });
    expect(v.status).toBe("open");
    expect(tick(v, v.deadline + 1).at(-1)).toMatchObject({ type: "closed", winner: "kochi" }); // no second extension
  });

  test("veto: 3 votes can't apply an option that breaks Ishita's cap without her OK", () => {
    const v = newVote("v", "Where?", opts(), squad, T0);
    cast(v, 1, "goa", squad);
    cast(v, 1, "goa", squad);
    cast(v, 2, "goa", squad);
    cast(v, 4, "kochi", squad);
    const [ev] = tick(v, T0 + 1);
    expect(ev).toMatchObject({ type: "closed", winner: "kochi" });
  });

  test("the affected person's 'no' removes an option whatever the votes; her own vote for it counts as OK", () => {
    const a = newVote("a", "Where?", opts(), squad, T0);
    for (const [tg, k] of [[1, "goa"], [1, "goa"], [2, "goa"], [4, "goa"]] as const) cast(a, tg, k, squad);
    expect(tick(a, T0 + 1)[0]).toMatchObject({ type: "closed", winner: "goa" });
    const b = newVote("b", "Where?", opts(), squad, T0);
    for (const [tg, k] of [[1, "goa"], [1, "goa"], [2, "goa"]] as const) cast(b, tg, k, squad);
    expect(veto(b, "4", "goa")).toBe(true);
    expect(cast(b, 4, "goa", squad).ok).toBe(false);
    expect(Object.values(b.ballots)).not.toContain("goa");
  });

  test("reopen needs a majority; quick 👍/👎 passes unless a majority says 👎", () => {
    expect(reopenAllowed(["1", "2"], ["1", "2", "4", "name:kabir"])).toBe(false);
    expect(reopenAllowed(["1", "2", "4"], ["1", "2", "4", "name:kabir"])).toBe(true);
    const q = newQuickVote("q", squad, T0);
    q.down.push("1", "2");
    expect(quickTick(q, T0 + minutes(16))).toBe("passed");
    const r = newQuickVote("r", squad, T0);
    r.down.push("1", "2", "4");
    expect(quickTick(r, T0 + 1)).toBe("rejected");
  });
});
