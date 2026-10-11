import { describe, expect, test } from "vitest";
import { suggestCities } from "../src/core/airports.js";
import { checkEvents, checkPlaces, isOpenAt } from "../src/core/checks.js";
import type { Event, Place } from "../src/core/types.js";

const src = { engine: "google_maps", fetchedAt: "2026-10-11T00:00:00Z" };
const place = (over: Partial<Place>): Place => ({ id: "place:x", source: src, name: "X", lat: 15.5, lng: 73.8, mapsUrl: "", reviews: 500, ...over });
const event = (over: Partial<Event>): Event => ({ id: "event:x", source: src, title: "Gig", date: "2026-11-21", venue: "Club", address: "Anjuna, Goa", link: "https://x", ...over });
const trip = { destination: "Goa", startDate: "2026-11-20", endDate: "2026-11-23" };

describe("place checks", () => {
  test("drops closed places and places with under 100 reviews", () => {
    const r = checkPlaces([
      place({ id: "a", status: "Permanently closed" }),
      place({ id: "b", status: "Temporarily closed" }),
      place({ id: "c", reviews: 40 }),
      place({ id: "d", status: "Open · Closes 10 pm" }),
    ]);
    expect(r.kept.map((p) => p.id)).toEqual(["d"]);
    expect(r.drops.map((d) => d.reason)).toEqual([
      "Google lists it as permanently closed",
      "Google lists it as temporarily closed",
      "only 40 reviews (needs 100+)",
    ]);
  });
});

describe("event checks", () => {
  test("keeps only dated, in-trip, in-destination events with a link", () => {
    const r = checkEvents(
      [event({ id: "ok" }), event({ id: "late", date: "2026-12-01" }), event({ id: "nodate", date: undefined }), event({ id: "far", address: "Candolim, India", venue: "Fort" }), event({ id: "nolink", link: undefined })],
      trip,
    );
    expect(r.kept.map((e) => e.id)).toEqual(["ok"]);
    expect(r.drops).toHaveLength(4);
  });
});

describe("opening hours", () => {
  // 2026-11-20 is a Friday.
  const fort = { operatingHours: { friday: "9:30 am–6 pm", saturday: "Closed" } };
  test("inside, outside, closed day and unknown day", () => {
    expect(isOpenAt(fort, "2026-11-20", "10:00")).toBe(true);
    expect(isOpenAt(fort, "2026-11-20", "19:00")).toBe(false);
    expect(isOpenAt(fort, "2026-11-21", "12:00")).toBe(false);
    expect(isOpenAt(fort, "2026-11-22", "12:00")).toBeUndefined();
  });
  test("split hours and past midnight", () => {
    const shack = { operatingHours: { friday: "11 am–3 pm, 7 pm–2 am" } };
    expect(isOpenAt(shack, "2026-11-20", "16:00")).toBe(false);
    expect(isOpenAt(shack, "2026-11-20", "23:30")).toBe(true);
    expect(isOpenAt({ operatingHours: { friday: "Open 24 hours" } }, "2026-11-20", "04:00")).toBe(true);
  });
});

test("suggests close city names for typos", () => {
  expect(suggestCities("Banglore")).toContain("bangalore");
  expect(suggestCities("Hydrabad")).toContain("hyderabad");
});
