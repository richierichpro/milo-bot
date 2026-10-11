import type { SerpParams } from "./serpapi.js";

// Every search the app makes is built here, so the same search always has the
// same params (and therefore hits the same cache file).

const LOCALE = { gl: "in", hl: "en" } as const;
const MONEY = { currency: "INR", ...LOCALE } as const;

export function flightParams(
  from: string,
  to: string,
  date: string,
  opts: { outboundTimes?: string; nonstop?: boolean } = {},
): SerpParams {
  return {
    engine: "google_flights",
    departure_id: from,
    arrival_id: to,
    outbound_date: date,
    type: 2,
    adults: 1,
    sort_by: 2,
    outbound_times: opts.outboundTimes,
    stops: opts.nonstop ? 1 : undefined,
    ...MONEY,
  };
}

export function hotelParams(
  destination: string,
  checkIn: string,
  checkOut: string,
  opts: { sortBy?: number; maxPrice?: number; rating?: number } = {},
): SerpParams {
  return {
    engine: "google_hotels",
    q: `hotels in ${destination}`,
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults: 2,
    sort_by: opts.sortBy ?? 8,
    max_price: opts.maxPrice,
    rating: opts.rating,
    ...MONEY,
  };
}

export type TravelMode = "driving" | "two_wheeler" | "walking" | "transit";
const TRAVEL_MODE: Record<TravelMode, number> = { driving: 0, two_wheeler: 9, walking: 2, transit: 3 };

/** Coordinates rounded to ~10 m so the same trip hits the same cache file. */
const coord = (p: { lat: number; lng: number }) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

export function directionsParams(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  mode: TravelMode,
  departAtUnix?: number,
): SerpParams {
  return {
    engine: "google_maps_directions",
    start_coords: coord(from),
    end_coords: coord(to),
    travel_mode: TRAVEL_MODE[mode],
    time: departAtUnix ? `depart_at:${departAtUnix}` : undefined,
    ...LOCALE,
  };
}

/** One place's details: admission prices, tours, price range. */
export function placeDetailsParams(placeId: string): SerpParams {
  return { engine: "google_maps", place_id: placeId, ...LOCALE };
}

export function mapsParams(q: string): SerpParams {
  return { engine: "google_maps", type: "search", q, ...LOCALE };
}

export function eventsParams(q: string): SerpParams {
  return { engine: "google", q, ...LOCALE };
}

export function exploreParams(from: string, outbound: string, ret: string): SerpParams {
  return {
    engine: "google_travel_explore",
    departure_id: from,
    arrival_area_id: "/m/03rk0",
    outbound_date: outbound,
    return_date: ret,
    adults: 1,
    ...MONEY,
  };
}

/**
 * "events in Goa". Adding the month ("events in Goa November 2026") makes Google
 * drop the events box entirely, so we search plainly and filter by date later.
 */
export function eventsQuery(destination: string): string {
  return `events in ${destination}`;
}
