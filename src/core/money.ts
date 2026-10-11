import type { CostLine, FlightPick, Hotel, Stop } from "./types.js";

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** 12345 → "₹12,345" */
export function formatINR(n: number): string {
  return `₹${inr.format(Math.round(n))}`;
}

export const roomsFor = (squadSize: number) => Math.ceil(squadSize / 2);

export function nightsBetween(start: string, end: string): number {
  return Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000));
}

export function hotelSharePerPerson(hotel: Hotel | undefined, nights: number, squadSize: number): number {
  if (!hotel?.pricePerNight || squadSize === 0) return 0;
  return (hotel.pricePerNight * nights * roomsFor(squadSize)) / squadSize;
}

export function costSplit(flights: FlightPick[], hotel: Hotel | undefined, nights: number): CostLine[] {
  const share = hotelSharePerPerson(hotel, nights, flights.length);
  return flights.map((f) => {
    const flightCost = (f.out?.pricePerPerson ?? 0) + (f.back?.pricePerPerson ?? 0);
    return { person: f.person, flights: flightCost, hotelShare: Math.round(share), total: Math.round(flightCost + share) };
  });
}

export const averageCost = (costs: CostLine[]) =>
  costs.length ? Math.round(costs.reduce((s, c) => s + c.total, 0) / costs.length) : 0;

export type PriceRange = { min: number; max?: number };

/** Google Maps price text → per-person range: "₹400–1,200", "₹2,000+", "₹200". Anything else → undefined. */
export function parsePriceRange(text?: string): PriceRange | undefined {
  if (!text || !text.includes("₹")) return undefined;
  const nums = (text.match(/\d[\d,]*/g) ?? []).map((n) => Number(n.replace(/,/g, "")));
  if (!nums.length) return undefined;
  if (text.trim().endsWith("+")) return { min: nums[0] };
  return { min: nums[0], max: nums[1] ?? nums[0] };
}

export type ActivityCosts = {
  min: number;
  /** Undefined when any listed price is open-ended ("₹2,000+"). */
  max?: number;
  priced: number;
  stops: number;
};

/** What one stop costs per person, from what Google lists: entry ticket, else typical spend. */
export function stopPrice(stop: Stop): PriceRange | undefined {
  if (stop.kind !== "place") return undefined;
  const entry = stop.item.prices?.admission[0];
  if (entry) return { min: entry.price, max: entry.price };
  return parsePriceRange(stop.item.prices?.priceRange) ?? parsePriceRange(stop.item.priceLevel);
}

/** Per-person total of the prices Google lists for the plan's stops. Unlisted stops are counted, not guessed. */
export function activityCosts(prices: (PriceRange | undefined)[]): ActivityCosts {
  let min = 0;
  let max: number | undefined = 0;
  let priced = 0;
  for (const r of prices) {
    if (!r) continue;
    priced++;
    min += r.min;
    max = max === undefined || r.max === undefined ? undefined : max + r.max;
  }
  return { min, max, priced, stops: prices.length };
}

/** "₹1,600–3,200" or "₹2,400+" */
export function formatRange(r: { min: number; max?: number }): string {
  if (r.max === undefined) return `${formatINR(r.min)}+`;
  return r.max === r.min ? formatINR(r.min) : `${formatINR(r.min)}–${inr.format(Math.round(r.max))}`;
}

export type Transfer = { from: string; to: string; amount: number };

/**
 * Equal split: everyone ends up paying the average. People who paid less than
 * the average pay those who paid more, largest amounts first.
 */
export function equalSplit(costs: CostLine[]): { average: number; transfers: Transfer[] } {
  if (!costs.length) return { average: 0, transfers: [] };
  const average = costs.reduce((s, c) => s + c.total, 0) / costs.length;
  const owe = costs.map((c) => ({ person: c.person, amount: average - c.total })).filter((x) => x.amount > 0.5).sort((a, b) => b.amount - a.amount);
  const owed = costs.map((c) => ({ person: c.person, amount: c.total - average })).filter((x) => x.amount > 0.5).sort((a, b) => b.amount - a.amount);
  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < owe.length && j < owed.length) {
    const amount = Math.min(owe[i].amount, owed[j].amount);
    if (Math.round(amount) > 0) transfers.push({ from: owe[i].person, to: owed[j].person, amount: Math.round(amount) });
    owe[i].amount -= amount;
    owed[j].amount -= amount;
    if (owe[i].amount < 0.5) i++;
    if (owed[j].amount < 0.5) j++;
  }
  return { average: Math.round(average), transfers };
}
