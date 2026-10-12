import type { Place } from "./types.js";

// What a place is, in words a trip planner uses. Google calls most sights just
// "Tourist attraction", so the name matters as much as the category.

export type Kind = "do" | "eat" | "night";
export type Theme = "beach" | "heritage" | "faith" | "nature" | "viewpoint" | "market" | "museum" | "activity" | "sight";

const text = (p: Pick<Place, "name" | "category">) => `${p.name} ${p.category ?? ""}`.toLowerCase();

/** A sight or activity, a meal, or a night out. */
export function placeKind(p: Pick<Place, "category">): Kind {
  const c = (p.category ?? "").toLowerCase();
  if (/night ?club|disco|pub\b|lounge|\bbar\b|cocktail|brewery|casino/.test(c)) return "night";
  if (/restaurant|cafe|café|coffee|bistro|bakery|dhaba|eatery|food|shack|diner|sweet|kitchen|grill|pizza/.test(c)) return "eat";
  return "do";
}

const THEMES: [Theme, RegExp][] = [
  ["activity", /water ?sports?|adventure|scuba|snorkel|parasail|kayak|canoe|rafting|bungee|cruise|boat|yacht|rental|tour (operator|agency)|travel agency|organi[sz]er|amusement|paintball|go ?kart|zipline|sports cent/],
  ["faith", /church|basilica|cathedral|chapel|temple|mandir|mosque|masjid|gurudwara|monastery|shrine|convent/],
  ["museum", /museum|gallery|art cent|heritage house|palácio|palacio|mansion/],
  ["heritage", /fort|historic|heritage|palace|tower|ruins|caves?|monument|landmark|carvings|old town/],
  ["viewpoint", /view ?point|lighthouse|sunset point|scenic|ghat|peak|hill/],
  ["nature", /waterfall|falls|wildlife|sanctuary|national park|lake|spring|garden|forest|bird|reserve|island|river|park/],
  ["beach", /beach|bay/],
  ["market", /market|bazaar|flea|shopping|street/],
];

export function theme(p: Pick<Place, "name" | "category">): Theme {
  const t = text(p);
  return THEMES.find(([, re]) => re.test(t))?.[0] ?? "sight";
}

/** Famous (lots of reviews) or a gem (loved by fewer people). Marked for the planner, never shown as fact. */
export function fame(p: Pick<Place, "rating" | "reviews">): "highlight" | "gem" | undefined {
  if ((p.reviews ?? 0) >= 10_000) return "highlight";
  if ((p.rating ?? 0) >= 4.3 && (p.reviews ?? 0) >= 100 && (p.reviews ?? 0) < 3_000) return "gem";
  return undefined;
}

/** Operators and rental shops crowd out real sights: keep only the best few. Must-do matches always stay. */
export function capActivities(places: Place[], keep: number, mustKeep: (p: Place) => boolean): Place[] {
  const shops = places
    .filter((p) => placeKind(p) === "do" && theme(p) === "activity" && !mustKeep(p))
    .sort((a, b) => (b.rating ?? 0) * Math.log10((b.reviews ?? 0) + 10) - (a.rating ?? 0) * Math.log10((a.reviews ?? 0) + 10));
  const drop = new Set(shops.slice(keep).map((p) => p.id));
  return places.filter((p) => !drop.has(p.id));
}

const FILLER = ["proper", "least", "some", "want", "with", "good", "nice", "really", "visit", "trip", "place", "places"];

/** Does a place answer a wish? A named place ("Fort Aguada") by its name; an activity ("bungee jumping") by any key word in name or category. */
export function matchesWish(p: Pick<Place, "name" | "category">, what: string): boolean {
  const t = text(p);
  const want = what.toLowerCase().trim();
  if (t.includes(want)) return true;
  const words = want.split(/\W+/).filter((w) => w.length > 3 && !FILLER.includes(w));
  if (!words.length) return false;
  // Every word in the name or category ("fort aguada" isn't any fort), or one whole word as the category ("Bungee Jumping Center").
  const cat = (p.category ?? "").toLowerCase();
  return words.every((w) => t.includes(w.slice(0, 5))) || words.some((w) => new RegExp(`\\b${w}\\b`).test(cat));
}
