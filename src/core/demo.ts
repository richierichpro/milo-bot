import type { SquadMember } from "./types.js";

// The demo squad and chat from CLAUDE.md, plus the limits listening must extract from it.

export const DEMO_TRIP = { destination: "Goa", startDate: "2026-11-20", endDate: "2026-11-23", interests: ["beaches"] };

export const DEMO_CHAT: { from: string; text: string }[] = [
  { from: "Aarav", text: "Goa finally?? 20-23 Nov works for me, budget 20k. Chapora fort is a must" },
  { from: "Meera", text: "I'm in! veg btw 🌱 and I want one proper beach day" },
  { from: "Kabir", text: "in but office till 6 on friday 😭" },
  { from: "Ishita", text: "bro I'm broke this month, 15k max. and no flights before 8am pls" },
  { from: "Aarav", text: "Milo plan it" },
];

export const DEMO_SQUAD: SquadMember[] = [
  {
    id: "name:aarav",
    name: "Aarav",
    city: "Hyderabad",
    constraints: [
      { id: "aarav-dates", hard: true, kind: "dates", start: "2026-11-20", end: "2026-11-23" },
      { id: "aarav-budget", hard: true, kind: "budget", max: 20000 },
      { id: "aarav-chapora", hard: false, kind: "must_do", what: "Chapora Fort" },
    ],
  },
  {
    id: "name:meera",
    name: "Meera",
    city: "Bengaluru",
    constraints: [
      { id: "meera-veg", hard: true, kind: "food", diet: "veg" },
      { id: "meera-beach", hard: false, kind: "vibe", what: "one proper beach day" },
    ],
  },
  {
    id: "name:kabir",
    name: "Kabir",
    city: "Delhi",
    constraints: [{ id: "kabir-friday", hard: true, kind: "flight_time", direction: "out", date: "2026-11-20", notBefore: "18:00", reason: "office till 6 on Friday" }],
  },
  {
    id: "name:ishita",
    name: "Ishita",
    city: "Pune",
    constraints: [
      { id: "ishita-budget", hard: true, kind: "budget", max: 15000 },
      { id: "ishita-8am", hard: true, kind: "flight_time", direction: "any", notBefore: "08:00", reason: "no flights before 8am" },
    ],
  },
];
