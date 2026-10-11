export type CallLogEntry = {
  engine: string;
  summary: string;
  source: "live" | "cache" | "demo";
  ms: number;
  at: string;
};

export type Source = { engine: string; url?: string; fetchedAt: string };

export type Flight = {
  id: string;
  source: Source;
  from: string;
  to: string;
  departTime: string; // "YYYY-MM-DD HH:MM"
  arriveTime: string;
  airline: string;
  airlineLogo?: string;
  flightNumbers: string[];
  stops: number;
  /** Layover airports, e.g. ["BLR"]. */
  via: string[];
  durationMin: number;
  pricePerPerson: number;
};

export type Hotel = {
  id: string;
  source: Source;
  name: string;
  lat: number;
  lng: number;
  pricePerNight?: number;
  rating?: number;
  reviews?: number;
  stars?: number;
  thumbnail?: string;
  amenities: string[];
  link?: string;
  /** e.g. "12:00 PM", from Google Hotels. */
  checkInTime?: string;
  checkOutTime?: string;
};

export type Place = {
  id: string;
  source: Source;
  name: string;
  category?: string;
  lat: number;
  lng: number;
  rating?: number;
  reviews?: number;
  priceLevel?: string;
  address?: string;
  hours?: string;
  thumbnail?: string;
  description?: string;
  mapsUrl: string;
  /** Google's open state, e.g. "Open · Closes 10 pm", "Temporarily closed". */
  status?: string;
  /** Opening hours by lowercase weekday, e.g. { friday: "9 am–8 pm" }. */
  operatingHours?: Record<string, string>;
  /** From a Google Maps place-details lookup (admission tickets, tours). */
  prices?: PlacePrices;
};

export type TicketOption = { title: string; price: number; priceText: string; link?: string; official?: boolean };
export type TourOption = { title: string; price: number; priceText: string; link?: string; provider?: string; rating?: number; reviews?: number };

export type PlacePrices = {
  source: Source;
  /** Entry tickets, cheapest first. */
  admission: TicketOption[];
  /** Bookable tours that include the place, cheapest first. Optional extras, not entry. */
  tours: TourOption[];
  /** Typical spend per person, e.g. "₹400–800" (mostly restaurants). */
  priceRange?: string;
};

export type Event = {
  id: string;
  source: Source;
  title: string;
  dateText?: string;
  /** "YYYY-MM-DD" when the date could be parsed */
  date?: string;
  venue?: string;
  address?: string;
  link?: string;
  thumbnail?: string;
};

export type Destination = {
  id: string;
  name: string;
  country?: string;
  lat?: number;
  lng?: number;
  airportCode?: string;
  /** Round trip, per person (Travel Explore prices both legs together). */
  flightPrice?: number;
  /** Travel Explore omits this for India searches; see CLAUDE.md. */
  hotelPrice?: number;
  startDate?: string;
  endDate?: string;
  thumbnail?: string;
  airline?: string;
  stops?: number;
  source: Source;
};

export type Person = { name: string; city: string };

export type TripInput = {
  squad: Person[];
  destination: string;
  startDate: string;
  endDate: string;
  interests: string[];
  budgetPerPerson?: number;
};

export type FlightPick = { person: string; city: string; out?: Flight; back?: Flight };

/** `why` is Milo's note: only facts from the candidate's own data, checked in code. */
export type Stop = ({ kind: "place"; item: Place } | { kind: "event"; item: Event }) & {
  time: string;
  why: string;
  /** Travel from the previous stop (or the hotel): "18 min drive (Google Maps)" or "≈ 2 km, short ride". */
  hop?: string;
  hopMinutes?: number;
  /** "hours not listed" when Google has no hours for that day. */
  hoursNote?: string;
};

export type Logistics = { time: string; label: string; at: "start" | "end" };

export type Day = {
  date: string;
  title: string;
  stops: Stop[];
  /** Straight-line km between the day's places × 1.3; approximate. */
  approxKm?: number;
  /** Arrivals, check-in, leave-for-airport rows. */
  logistics?: Logistics[];
  leaveBy?: string;
  travelMinutes?: number;
  /** Local sunset "HH:MM" (suncalc). */
  sunset?: string;
};

export type Verification = { total: number; verified: number; removed: string[] };

export type CostLine = { person: string; flights: number; hotelShare: number; total: number };

export type Itinerary = {
  title: string;
  summary: string;
  trip: TripInput;
  flights: FlightPick[];
  /** Set by the squad flight optimiser (Step 6). */
  arrivalWindow?: { first: string; last: string; extraVsCheapest: number };
  hotel?: Hotel;
  /** Typical km from the hotel to the plan's places. */
  hotelDistanceKm?: number;
  rooms: number;
  nights: number;
  days: Day[];
  verification: Verification;
  costs: CostLine[];
  createdAt: string;
};

// ---------- People and their limits ----------

/** Hard limits are never broken without the person's OK; soft ones are preferences. */
export type Constraint = { id: string; hard: boolean; sourceMessageId?: number; waived?: string } & (
  | { kind: "budget"; max: number }
  | { kind: "dates"; start: string; end: string }
  | { kind: "food"; diet: "veg" | "jain" | "vegan" | "no_beef" | "allergy"; detail?: string }
  /** Flight departure window. date limits it to one day; direction to one leg. */
  | { kind: "flight_time"; direction: "out" | "back" | "any"; date?: string; notBefore?: string; notAfter?: string; reason?: string }
  | { kind: "must_do"; what: string }
  | { kind: "no_go"; what: string }
  | { kind: "vibe"; what: string }
);

export type SquadMember = {
  /** Telegram user id as a string, or "name:<slug>" for friends added by someone else. */
  id: string;
  name: string;
  city?: string;
  telegramUserId?: number;
  /** Who votes for them when they aren't on Telegram. */
  proxyFor?: string;
  constraints: Constraint[];
};

/** One dropped candidate and why (shown under "See sources"). */
export type Drop = { id: string; name: string; kind: "place" | "event" | "hotel" | "flight"; reason: string };
