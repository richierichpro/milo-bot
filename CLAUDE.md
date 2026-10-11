# Milo: the trip planner that lives in your group chat

## The project
Hackathon entry for the SerpApi India Hackathon 2026, track "Travel & Local Discovery". Judged on idea strength, originality, technical complexity, usefulness and meaningful SerpApi usage. Needs a public GitHub repo with setup instructions and a demo video under 3 minutes showing it running locally.

## What Milo does
Every friend group has a trip chat where the plan never happens, because everyone's limits are scattered across the messages. Add Milo to the group and it plans like a real planner:
1. Listens to the chat and picks up each friend's limits.
2. Shows "Here's what I heard" for everyone to confirm.
3. Finds where the squad can afford to go and lets the group vote.
4. Searches within every person's limits; if something has to give, asks only the person affected.
5. Builds the trip with real logistics: flights that land together, a hotel near the action, days with real travel times.
6. Ends with a boarding pass for each friend showing why the plan works for them.

## Hero: "Works for everyone"
- Listen: while listening is on, Milo reads normal group messages and extracts each person's constraints: home city, dates/availability, budget cap, food needs (veg/Jain/allergies), flight time limits, must-dos, no-gos, vibe. Each is hard (budget cap, time limits, food needs) or soft (preferences). Store only the extracted constraints plus the source message id, never message text. React 👀 to each message a constraint came from.
- Heard card: an image card with one row per friend and their constraint chips (hard ones marked), plus buttons "Looks right ✅" and "Fix mine". Only the person themselves can fix their row; anyone else tapping gets a pop-up "This one's for Kabir".
- Solve within limits: per-person flight searches using their time limits, hotel searches capped by the tightest budget, Maps searches for food needs, Directions for transfers. Every hard constraint is checked for every person in code, never by Claude alone.
- Negotiate: if no plan meets every hard constraint, find the smallest compromises from real alternatives and ask only the affected person, with 2–3 options and real numbers, e.g. "Ishita, Goa comes to ₹16,400 for you, ₹1,400 over your cap. A: 1-stop flight → ₹14,900. B: room for 3 → ₹15,200. C: keep it and go over." Never break a hard limit without that person's explicit OK.
- Prove: the final plan ends with one boarding pass per person, sent as an album: their flights plus a "Works for you" tick for each of their constraints, each backed by data ("Flight leaves DEL 19:10, after work ✓"). A waived constraint shows "⚠ you agreed to go ₹1,400 over".

## Users never type commands
- When added to a group, Milo posts a short intro with one button: "Plan a trip ✈️". Tapping it turns listening on and says so.
- Milo checks getMe.can_read_all_group_messages. If it's false, it tells the group in one friendly message how to fix it (disable privacy in @BotFather and re-add Milo, or make Milo an admin).
- Everything else is natural language or buttons:
  - Squad: people just say who's coming and from where ("Kabir's in, he's from Delhi"). Milo adds them and confirms with an Undo button.
  - While people chat, Milo stays quiet apart from 👀 reactions. When it has enough to plan, it posts one "Plan it now" button (once).
  - Start planning: "Milo, plan it" in any wording, or the button.
  - Missing info is asked only after planning starts, one question at a time, addressed to the right person, with quick-reply buttons (dates: "This weekend" / "Next weekend" / "Pick dates"; budget: ₹10k / ₹15k / ₹20k / "Other"; food: Veg / Non-veg / Jain / "No preference"). "Other" accepts a typed answer.
  - Changes: reply to any Milo message or mention Milo in plain words.
  - Fix constraints, vote, see sources, pause/resume: buttons only.
- A pinned Trip card shows the stage, the squad, decisions so far and what's pending, with buttons for the next step plus "Pause Milo". Edit it in place after every decision. If Milo can't pin, it skips pinning.
- Slash commands exist only as hidden shortcuts for testing: not in the command menu, never mentioned in Milo's messages or the user guide.
- Tone: a friendly, organised planner. Uses names, asks one thing at a time, summarises decisions, never more than 3 messages in a row.

## Voting rules
- Custom inline-button votes (not native polls, because we need proxy votes and vetoes): an image card of the options plus buttons showing live counts and voter initials, edited in place.
- Group choices (destination, dates, package, hotel, any options Milo offers) → vote. Each option shows cost per person and who it affects.
- Conflicts between soft preferences → Milo builds 2–3 options from real results, including "split the day" when the group divides (two groups, meet for a shared meal), and runs a vote.
- Hard limits are protected: options that break someone's hard constraint are left out or labelled "needs <name>'s OK"; that person's "no" removes the option regardless of votes.
- Whoever is affected decides: a change that only affects one person (their own flight) → that person picks, no vote. A change affecting everyone → vote on a before/after with the ₹ difference.
- Small changes (swap one café for another, shift a time by ≤ 1 h) → quick 👍/👎; it goes through unless a majority votes 👎 within QUICK_VOTE_MIN minutes.
- One vote per squad member. Friends without Telegram are voted for by whoever added them, shown as "Aarav for Kabir". Deadline VOTE_MIN minutes. Ping non-voters by name at half time. Close early when everyone has voted or the result can't change. Tie → pick the cheaper/fairer option, say why, allow objections for 10 min. Under half voted at the deadline → extend once and ping. "Reopen" needs a majority.
- Results: a "Decided" card, and the Trip card updates.

## Planning like a real planner
- Transfers: airport → hotel and hotel → airport with real times from google_maps_directions. Leave-for-airport time = departure − 2 h − transfer time.
- Hotel check-in/check-out times from Google Hotels (check_in_time, check_out_time). If people land before check-in, start with "drop bags at the hotel".
- Pacing: at most 4 stops on full days, a free afternoon block on beach trips, a late start after a night out, light travel days.
- Each day stays in one area. Real hop times for hops over 3 km (two-wheeler mode when the vibe suggests scooters, otherwise driving). At most 12 directions searches per plan, cached. Shorter hops show "≈ X km, short ride".
- Meals at meal times; a beach or viewpoint near sunset (sunset computed with suncalc for that date and place); opening hours and closed days respected.
- Food needs: if anyone is veg or Jain, every day has at least one suitable meal stop, found by searching (e.g. "vegetarian restaurants in <area>") and used only if its category or description supports it.
- Arrival spread is a soft goal. Hard limits (e.g. Kabir can't leave before 18:00 Friday) always win, and the plan adapts ("Kabir joins at dinner").
- Each day shows "Leave hotel by HH:MM" and total travel time.

## No fakes (always)
- Grounded: every flight, hotel, place and event is a real SerpApi result. Claude only chooses and arranges candidates by id; code checks every id against the candidate pool and removes unknown ones.
- Claude's notes and day titles may only use facts present in that candidate's data. No invented superlatives ("big-name", "famous", "the squad's favourite"). Events are described exactly as titled; a tribute or Candlelight concert is never described as the artist performing. A code check rejects any number, price, rating or proper noun in a note that isn't in the candidate data; regenerate once, otherwise show no note.
- Events: keep only if the date parses and falls inside the trip dates, the address or venue mentions the destination, and there's a link or ticket link.
- Places: drop anything marked closed (temporarily or permanently) in the raw JSON, and anything with fewer than 100 reviews. Scheduled times must fall within operating_hours when known; otherwise show "hours not listed".
- Advice is fine ("carry a government photo ID"); facts must come from a search.
- Demo data only ever comes from recorded real API calls. No hand-written fixtures.
- Every item carries proof: source (Google Flights / Hotels / Maps / Events), rating or price, "checked N min ago", and a link. A "See sources" button lists every search and every dropped item with its reason.

## Design: cards look exactly like the web app
- Read my previous web app: fonts (next/font in app/layout.tsx), Tailwind colours, radius, and the components PlanHeader, FlightsSection (with the arrival timeline), HotelCard, DayTimeline, StopCard, ProofLine, the cost split table and the day colours. Copy the tokens into src/cards/theme.ts and bundle the same font files (download the Google Fonts TTFs into assets/fonts).
- Render every card as HTML + CSS with those tokens and screenshot it with Playwright (Chromium, deviceScaleFactor 2) into a PNG buffer. Reuse one browser. 1080 px wide; height fits the content.
- Day maps: Leaflet with OpenStreetMap tiles inside the card HTML, same numbered day-coloured markers as the web app; wait for tiles to load; if they fail, render the card without the map.
- Cards: Heard; Destination shortlist (photo postcards, ≈ ₹ each, budget-fit chips); Vote and Decided; Plan header (title, dates, ₹ per person, "✓ N/N verified with live Google data", search count); Flights (same rows as the app + arrival timeline with highlighted window and airport); Hotel; one per day (same stop cards as the app: time, numbered day-coloured dot, photo, name, category, ★ rating (reviews), "Milo's note", proof line) with the map; Boarding passes (app colours, ticket shape, large IATA codes, "Works for you" ticks); Cost split (same table as the app, over-budget totals in red).
- Telegram images aren't clickable, so after each album send one short text message with the key facts and source links.
- Text messages: fixed emoji icon set (✈️ 🏨 📍 🍽 🎟 💸 ✅ 🗳), bold names, monospace times and codes, italic proof lines, blank line between blocks. Long details go in expandable blockquotes.
- Chat feel: "typing" / "upload_photo" chat actions while working; one self-updating status message with a ▰▱ progress bar that collapses to "✓ N live searches"; related cards sent as albums.
- Set the bot description and short description via the Bot API: "I plan your squad's trip right here in the chat."

## SerpApi engines (GET https://serpapi.com/search.json)
- google_travel_explore: departure_id (IATA), arrival_area_id (/m/03rk0 = India), outbound_date, return_date, adults, currency, gl, hl. Response destinations[]: destination_id, name, country, gps_coordinates{latitude,longitude}, thumbnail, destination_airport.code, flight_price, hotel_price, flight_duration, number_of_stops, airline, start_date, end_date. (Find out whether hotel_price is per night or for the whole stay by comparing with google_hotels for the same city and dates; write the answer here.)
- google_flights: departure_id, arrival_id (IATA; comma-separated allowed, e.g. "GOI,GOX"), outbound_date, type=2, adults=1, stops (1 = nonstop), sort_by (2 = price), outbound_times (e.g. "18,23" = departs 6pm–midnight). Response best_flights[] + other_flights[]; each has flights[] segments (departure_airport{name,id,time}, arrival_airport{name,id,time}, airline, airline_logo, flight_number, duration), layovers[], total_duration, price. Times look like "2026-11-20 07:45". Also price_insights{lowest_price, price_level, typical_price_range}.
- google_hotels: q, check_in_date, check_out_date, adults, sort_by (3 = lowest price, 8 = highest rating), min_price, max_price, rating (8 = 4.0+). Response properties[]: name, link, gps_coordinates, rate_per_night.extracted_lowest, total_rate.extracted_lowest, overall_rating, reviews, hotel_class, extracted_hotel_class, images[].thumbnail, amenities[], property_token, check_in_time, check_out_time.
- google_maps: type=search, q, optional ll=@lat,lng,13z. Response local_results[]: title, place_id, gps_coordinates, rating, reviews, price, type, address, hours, operating_hours, thumbnail, description.
- google_maps_directions: start_coords / end_coords ("lat,lng"), travel_mode (0 driving, 9 two-wheeler, 2 walking, 3 transit), time ("depart_at:<unix timestamp>"). Response directions[]: travel_mode, duration (s), distance (m), formatted_duration, formatted_distance. Use the first route for the requested mode.
- google (web search) for events: q="events in Goa November 2026". Read events_results[]: title, date (object {start_date, when} or a plain string), address[], link, ticket_info[], venue, thumbnail. Don't use the deprecated google_events engine.

## Data rules
- Money is INR: currency=INR, gl=in, hl=en. Format ₹12,345 (en-IN).
- Flights: always adults=1, one leg at a time (type=2). Keep every nonstop option plus the 8 cheapest (deduped). Multiply by people ourselves.
- Goa has two airports, GOI (Dabolim) and GOX (Mopa), about 1.5–2 h apart by road. "Landing together" means the same airport.
- Hotels: adults=2, rooms = ceil(squad size / 2). Prefer hotels within ~5 km of the centre of the plan's places; show "≈ X km from most of your plan".

## Tech
Node 20+, TypeScript (strict, ESM), tsx, grammY with long polling + @grammyjs/auto-retry, @anthropic-ai/sdk (structured output through forced tool calls), Playwright (card rendering), suncalc, vitest. Make sure message, callback_query and my_chat_member updates are received.
- CLAUDE_MODEL (planning) and CLAUDE_MODEL_FAST (reading chat messages).
- Keep token costs low (user decision, 2026-10-11): both models default to claude-haiku-5-5. Every Claude response is cached on disk by request hash (repeat runs are free); prompts use compact candidate lines with short ids, never raw JSON; stable system prompts and tools use prompt caching; extraction runs at low effort with small max_tokens; listening stays batched (15 s quiet or 10 messages).
- Listening is batched: buffer group messages and run one fast-model extraction call after 15 s of quiet or 10 messages, whichever comes first.
- All SerpApi calls go through src/core/serpapi.ts (disk cache, demo mode, call log). All Claude calls go through src/core/claude.ts.
- Chat state as JSON in .data/chats/<chatId>.json. HTML parse mode, all text escaped. Text ≤ 4,096 chars, captions ≤ 1,024. About 400 ms between consecutive messages.

## Folders
- src/core/: serpapi, normalize, types, airports, gather, checks, directions, squad, constraints, planner, agent, claude, money
- src/cards/: theme, templates, render
- src/bot/: index, listen, conversation, votes, tripcard, render, state
- scripts/: try-search.ts, simulate.ts, record-demo.ts, reality-check.ts (run with npx tsx --env-file=.env.local)
- assets/fonts/, demo-data/ (committed); .data/ and .cache/ (gitignored)

## Demo squad and chat (use for all tests and the simulator)
Aarav (Hyderabad), Meera (Bengaluru), Kabir (Delhi), Ishita (Pune). Goa, 2026-11-20 to 2026-11-23. The messy chat:
- Aarav: "Goa finally?? 20-23 Nov works for me, budget 20k. Chapora fort is a must"
- Meera: "I'm in! veg btw 🌱 and I want one proper beach day"
- Kabir: "in but office till 6 on friday 😭"
- Ishita: "bro I'm broke this month, 15k max. and no flights before 8am pls"
- Aarav: "Milo plan it"

## How to work
Follow PLAN.md in order, keep its Progress list current, verify each step yourself, and ask only when blocked or before anything hard to undo.
