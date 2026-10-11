import { formatINR } from "./money.js";
import type { Constraint, CostLine, Day, FlightPick, Hotel, Place, SquadMember } from "./types.js";

// Every hard limit is checked here, in code, for every person. Evidence always
// comes from real data (a flight time, a price, a restaurant's category).

export type PlanForCheck = {
  startDate: string;
  endDate: string;
  flights: FlightPick[];
  costs: CostLine[];
  hotel?: Hotel;
  days?: Day[];
};

export type ConstraintCheck = {
  constraint: Constraint;
  ok: boolean;
  /** Not checkable yet (e.g. food before the days are planned). */
  pending?: boolean;
  evidence: string;
  /** Set when the person agreed to break it. */
  waived?: string;
};

const DIET_MATCH: Record<string, RegExp> = {
  veg: /\b(pure )?veg(etarian|an)?\b|\bjain\b/i,
  vegan: /\bvegan\b/i,
  jain: /\bjain\b/i,
  no_beef: /./, // any meal stop can serve this; not a search filter
  allergy: /$^/, // can't be confirmed from search data
};

const MEAL_CATEGORY = /restaurant|caf[eé]|bistro|kitchen|thali|dhaba|food|bakery|eatery|diner|canteen/i;

/** A place's own Google data says it suits this diet (category or description). */
export function suitsDiet(place: Pick<Place, "category" | "description" | "name">, diet: string): boolean {
  const text = `${place.category ?? ""} ${place.description ?? ""}`;
  return (DIET_MATCH[diet] ?? /$^/).test(text);
}

const hm = (t: string) => t.slice(11, 16);
const dayMonth = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

function checkOne(c: Constraint, person: SquadMember, plan: PlanForCheck): ConstraintCheck | undefined {
  const pick = plan.flights.find((f) => f.person === person.name);
  const cost = plan.costs.find((x) => x.person === person.name);
  const waived = c.waived;
  const result = (ok: boolean, evidence: string, pending = false): ConstraintCheck => ({ constraint: c, ok: ok || !!waived, pending, evidence, waived });

  switch (c.kind) {
    case "budget": {
      if (!cost) return result(false, "No cost yet", true);
      const parts = `flights ${formatINR(cost.flights)} + hotel share ${formatINR(cost.hotelShare)}`;
      return cost.total <= c.max
        ? result(true, `${formatINR(cost.total)} for you (${parts}), within your ${formatINR(c.max)}`)
        : result(false, `${formatINR(cost.total)} for you (${parts}), ${formatINR(cost.total - c.max)} over your ${formatINR(c.max)} cap`);
    }
    case "flight_time": {
      const legs = [
        ...(c.direction !== "back" && pick?.out ? [pick.out] : []),
        ...(c.direction !== "out" && pick?.back ? [pick.back] : []),
      ].filter((f) => !c.date || f.departTime.startsWith(c.date));
      if (!legs.length) return result(false, "No flight picked yet", true);
      const bad = legs.find((f) => (c.notBefore && hm(f.departTime) < c.notBefore) || (c.notAfter && hm(f.departTime) > c.notAfter));
      const f = bad ?? legs[0];
      const limit = [c.notBefore && `after ${c.notBefore}`, c.notAfter && `before ${c.notAfter}`].filter(Boolean).join(" and ");
      return result(!bad, `Flight leaves ${f.from} ${hm(f.departTime)}${bad ? `, not ${limit}` : `, ${limit}${c.reason ? ` (${c.reason})` : ""}`}`);
    }
    case "dates": {
      const ok = plan.startDate >= c.start && plan.endDate <= c.end;
      return result(ok, `Trip is ${dayMonth(plan.startDate)}–${dayMonth(plan.endDate)}; you're free ${dayMonth(c.start)}–${dayMonth(c.end)}`);
    }
    case "food": {
      if (!plan.days?.length) return result(false, "Checked once the days are planned", true);
      const label = c.diet === "veg" ? "veg" : c.diet;
      const perDay = plan.days.map((d) => d.stops.find((s) => s.kind === "place" && MEAL_CATEGORY.test(s.item.category ?? "") && suitsDiet(s.item, c.diet)));
      const missing = perDay.findIndex((s) => !s);
      if (missing >= 0) return result(false, `Day ${missing + 1} has no meal stop listed as ${label} on Google`);
      const first = perDay[0]!;
      return result(true, `A ${label} meal every day, e.g. ${first.kind === "place" ? first.item.name : ""} (${first.kind === "place" ? first.item.category : ""})`);
    }
    case "must_do": {
      const want = c.what.toLowerCase();
      const at = plan.days?.findIndex((d) => d.stops.some((s) => (s.kind === "place" ? s.item.name : s.item.title).toLowerCase().includes(want)));
      if (at === undefined) return result(false, "Checked once the days are planned", true);
      return result(at >= 0, at >= 0 ? `${c.what} is on day ${at + 1}` : `${c.what} isn't in the plan`);
    }
    default:
      // Vibe and no-go preferences guide the plan but can't be proven from data.
      return undefined;
  }
}

/** Every checkable limit for one person, with evidence. */
export function checkPerson(plan: PlanForCheck, person: SquadMember): ConstraintCheck[] {
  return person.constraints.flatMap((c) => {
    const r = checkOne(c, person, plan);
    return r ? [r] : [];
  });
}

/** Hard limits that fail and aren't waived (pending ones don't count yet). */
export const failingHard = (checks: ConstraintCheck[]) => checks.filter((r) => r.constraint.hard && !r.ok && !r.pending);
