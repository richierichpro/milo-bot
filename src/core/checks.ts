import type { Drop, Event, Place, TripInput } from "./types.js";

// The "No fakes" rules for search results. Every drop is recorded with a reason
// so "See sources" can show what was left out and why.

export const MIN_REVIEWS = 100;

export function checkPlaces(places: Place[]): { kept: Place[]; drops: Drop[] } {
  const kept: Place[] = [];
  const drops: Drop[] = [];
  for (const p of places) {
    const drop = (reason: string) => drops.push({ id: p.id, name: p.name, kind: "place", reason });
    if (/permanently closed/i.test(p.status ?? "")) drop("Google lists it as permanently closed");
    else if (/temporarily closed/i.test(p.status ?? "")) drop("Google lists it as temporarily closed");
    else if ((p.reviews ?? 0) < MIN_REVIEWS) drop(`only ${p.reviews ?? 0} reviews (needs ${MIN_REVIEWS}+)`);
    else kept.push(p);
  }
  return { kept, drops };
}

const norm = (s: string) => s.toLowerCase();

export function checkEvents(events: Event[], trip: Pick<TripInput, "destination" | "startDate" | "endDate">): { kept: Event[]; drops: Drop[] } {
  const kept: Event[] = [];
  const drops: Drop[] = [];
  const dest = norm(trip.destination);
  for (const e of events) {
    const drop = (reason: string) => drops.push({ id: e.id, name: e.title, kind: "event", reason });
    const where = norm(`${e.venue ?? ""} ${e.address ?? ""}`);
    if (!e.date) drop(`date "${e.dateText ?? "?"}" couldn't be read`);
    else if (e.date < trip.startDate || e.date > trip.endDate) drop(`on ${e.date}, outside the trip dates`);
    else if (!where.includes(dest)) drop(`venue/address doesn't mention ${trip.destination}`);
    else if (!e.link) drop("no link or ticket link");
    else kept.push(e);
  }
  return { kept, drops };
}

// ---------- Opening hours ----------

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "9 am", "10:30 pm", "12 am" → minutes after midnight. */
function toMinutes(t: string, fallbackMeridiem?: string): number | undefined {
  const m = t.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return undefined;
  let h = Number(m[1]) % 12;
  const meridiem = m[3] ?? fallbackMeridiem;
  if (meridiem === "pm") h += 12;
  return h * 60 + Number(m[2] ?? 0);
}

/**
 * Is the place open at this local time? true / false, or undefined when Google
 * doesn't list hours for that day ("hours not listed").
 */
export function isOpenAt(place: Pick<Place, "operatingHours">, date: string, hhmm: string): boolean | undefined {
  const day = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const text = place.operatingHours?.[day];
  if (!text) return undefined;
  if (/open 24 hours/i.test(text)) return true;
  if (/^closed$/i.test(text.trim())) return false;
  const at = toMinutes(hhmm.replace(/^(\d{1,2}):(\d{2})$/, (_, h, m) => `${Number(h) % 12 || 12}:${m} ${Number(h) >= 12 ? "pm" : "am"}`));
  if (at === undefined) return undefined;
  // "9 am–1 pm, 4–9 pm": any range containing the time.
  for (const range of text.split(",")) {
    const [a, b] = range.split(/[–-]/).map((x) => x.trim());
    if (!a || !b) continue;
    const endMeridiem = b.toLowerCase().match(/am|pm/)?.[0];
    const start = toMinutes(a, a.match(/am|pm/i) ? undefined : endMeridiem);
    let end = toMinutes(b);
    if (start === undefined || end === undefined) continue;
    if (end <= start) end += 24 * 60; // past midnight
    const t = at < start ? at + 24 * 60 : at;
    if (t >= start && t < end) return true;
  }
  return false;
}
