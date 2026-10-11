# Milo build plan

## Progress
P0
- [x] 0 Setup
- [x] 1 Search layer + reality checks
- [x] 2 Squad engine + constraint checker
- [x] 3 Card renderer (web app design)
- [x] 4 Bot core: intro, listening, natural-language squad, Trip card
- [x] 5 Heard card, questions, vote system, destination vote
- [x] 6 Solve within limits + negotiate
- [ ] 7 Itinerary with logistics, final plan cards, boarding passes
- [ ] 8 Demo mode, simulator, README  (STOP: run the full demo in my Telegram test group)
P1 (ask me before each)
- [ ] 9 Conflict votes + split day
- [ ] 10 Packages vote (Budget / Sweet spot / Splurge)
- [ ] 11 Edits by chat
- [ ] 12 "Running late" re-plan
- [ ] 13 Bookings checklist + settle-up

## Step 0: Setup
- If code exists: keep what works and rename Pakka → Milo everywhere (grep -ri pakka outside node_modules, .git and .cache must find nothing).
- Install grammy, @grammyjs/auto-retry, @anthropic-ai/sdk, playwright, suncalc; dev: tsx, typescript, vitest, @types/node, @types/suncalc. Run npx playwright install chromium.
- .env.example: SERPAPI_API_KEY=, ANTHROPIC_API_KEY=, TELEGRAM_BOT_TOKEN=, CLAUDE_MODEL=claude-sonnet-5-5, CLAUDE_MODEL_FAST=claude-haiku-5-5, DEMO_MODE=false, VOTE_MIN=120, QUICK_VOTE_MIN=15. Copy to .env.local. Gitignore .env.local, .data/, .cache/.
- npm scripts: bot, simulate, reality-check, test, typecheck. git init.
Verify: npm run typecheck passes; git status doesn't list .env.local.

## Step 1: Search layer + reality checks
- serpapi.ts: serpSearch(params, { log }) adds api_key, 30 s timeout; disk cache .cache/serpapi/<engine>/<sha1 of sorted params without api_key>.json, read first, no expiry; demo mode (DEMO_MODE=true or no key) reads only demo-data/serpapi/... and errors clearly if missing; throws on an `error` field; logs { engine, summary, source: live|cache|demo, ms, at }; never stores the key.
- types.ts / normalize.ts: Flight, Hotel, Place, Event, Destination, each with id + source { engine, url?, fetchedAt }. Stable ids from SerpApi data (place:<place_id>, hotel:<property_token>, event:<hash of title+date>, flight:<flight numbers+depart time>, dest:<destination_id>). mapsUrl = https://www.google.com/maps/place/?q=place_id:<place_id>. Parse defensively; merge best_flights and other_flights; multi-segment → one Flight with stops and via.
- airports.ts: about 40 Indian cities and destinations → IATA code(s); no-airport places map to the nearest with a note (Manali→KUU, Munnar→COK, Coorg→IXE, Rishikesh→DED, Ooty→CJB, Pondicherry→MAA); Goa→"GOI,GOX"; case-insensitive; close-match suggestions for typos.
- gather.ts: gatherCandidates(trip, constraints, onProgress): per-person flights out and back (respecting their time limits through outbound_times / stops), hotels (max_price from the tightest budget), Maps queries (attractions, restaurants, cafes, up to 3 interests, food-need queries), events. A failed search is recorded; the rest carry on.
- checks.ts: the No-fakes rules for places and events, recording every drop with a reason.
- directions.ts: getTravelTime(from, to, mode, departAt) via google_maps_directions, cached, with a per-plan cap.
Verify: scripts/try-search.ts runs one search per engine for Aarav's trip and prints 2 items per type plus drops with reasons; a second run is all cache. Write the hotel_price answer into CLAUDE.md.

## Step 2: Squad engine + constraint checker
- findDestinations(squad, dates, constraints): one google_travel_explore search per home city; join by destination id; keep destinations every city can reach; skip home cities; per-person estimate = flight_price + hotel share; drop options that break any hard budget unless nothing is left; rank by fit, then groupTotal + 0.5 × fairnessGap; top 4; labelled as estimates.
- pickSquadFlights: filter each person's options by their hard time limits first, then try every combination (trim to under 50,000). Score = total price + ₹300 per 10 min of arrival spread + ₹4,000 per person at a different airport from the majority + ₹250 per hour beyond that route's fastest option + ₹1,000 per stop. Same for returns. Constants in one place.
- constraints.ts: checkPerson(plan, person) → [{ constraint, ok, evidence, waived? }], with evidence taken from real data (flight time, price, restaurant category).
- money.ts: per person = flights + hotel share; formatINR; equalSplit with who-pays-whom.
Verify: vitest tests: same-airport nonstops beat cheap 6-hour one-stops when the price gap is small; Kabir never gets a flight before 18:00 Friday; Ishita never gets one before 08:00; checkPerson reports correctly; equalSplit settles to zero.

## Step 3: Card renderer
- Build theme.ts from my web app, templates for every card in CLAUDE.md, and render.ts (Playwright, one shared browser, PNG buffers).
Verify: a test renders every card with demo data, checks nothing overflows (scrollWidth ≤ 1080) and every image is valid. Save them to a temp folder and look at them yourself to confirm they match the web app's style. Fix anything that doesn't.

## Step 4: Bot core
- Intro on my_chat_member with "Plan a trip ✈️"; privacy check via getMe; listening with batching, the fast model and a forced tool understand_messages → { constraint updates per person (hard/soft, source message id), people added or removed, intents: plan_now | edit_request | question_to_milo | pause }; 👀 reactions; natural-language squad adds with Undo; the "Plan it now" button once there's enough; pinned Trip card with next-step buttons and "Pause Milo"; state in .data/; hidden slash commands for testing only.
Verify: the simulator feeds the demo chat; extracted constraints match: Aarav budget 20k + must-do Chapora Fort; Meera veg (hard) + beach day (soft); Kabir departs after 18:00 on 2026-11-20 (hard); Ishita budget 15k (hard) + no flights before 08:00 (hard); intent plan_now on the last line.

## Step 5: Heard card, questions, vote system, destination vote
- Heard card with "Looks right ✅" / "Fix mine" (owner-only, others get the pop-up).
- Missing-info questions after planning starts, one at a time, addressed to the right person, quick-reply buttons.
- votes.ts implementing every voting rule in CLAUDE.md.
- Destination vote: findDestinations → shortlist card → vote → Decided card → Trip card update.
Verify: vitest tests for proxy votes, deadline ping, early close, tie-break, quorum extension, and veto (3 votes can't apply an option that breaks Ishita's cap without her OK). The simulator reaches "Decided: Goa".

## Step 6: Solve within limits + negotiate
- Gather with constraints, choose flights and hotel, run checkPerson for everyone. If any hard constraint fails, search real alternatives for the smallest compromise and ask only that person (owner-only buttons). Apply the answer, re-check, and record any waiver.
Verify: the simulator shows Ishita's budget question with real numbers; after her choice every hard constraint passes or is explicitly waived.

## Step 7: Itinerary with logistics, final plan cards, boarding passes
- planner.ts: Claude (forced tool submit_itinerary { title, summary, hotelId, days: [{ date, title, stops: [{ id, time, note }] }] }) gets compact candidate lines and every rule from "Planning like a real planner" and "No fakes". Afterwards: grounding check, note check, hours check, hotel-distance check (over 10 km from most stops → reconsider once), then drop anything still failing. Add transfers, check-in, leave-by times and sunset timing.
- Post: header + flights + hotel cards (album), one card per day (album), cost split card, follow-up text messages with sources, then the boarding-pass album with "Works for you" ticks, and a "See sources" button.
Verify: scripts/reality-check.ts prints PASS/FAIL per item and a summary (e.g. "27/27 items pass"); checkPerson is all ✓ or waived for everyone; every caption ≤ 1,024 and every text ≤ 4,096 with valid HTML.

## Step 8: Demo mode, simulator, README
- scripts/record-demo.ts: with real keys, run the full P0 demo once and copy every SerpApi response used into demo-data/serpapi/. claude.ts records Claude responses into demo-data/claude/ (keyed by a hash of the request without time-based values) and replays them in demo mode. Fail if any demo-data file wasn't recorded. Strip any key values; grep for "api_key" must find nothing.
- scripts/simulate.ts: runs the whole P0 demo through the real bot handlers with a fake Telegram transport, using only the natural-language chat and button taps, and prints the conversation (DEMO_MODE=true npm run simulate works with no keys).
- README.md: one-line pitch; the problem; how it works (mermaid: listen → heard → destination vote → solve within limits → negotiate → itinerary with logistics → reality checks → boarding passes); table of SerpApi engines and what each does; setup (BotFather token, disable privacy, make Milo an admin, keys, npm install, npx playwright install chromium, npm run bot); demo mode and simulator; tech; what's next. No slash commands in the user guide.
- npm run typecheck and npm test pass.
Then STOP: start the bot and run the full demo in my Telegram test group (send the demo chat lines yourself through the simulator into the real group if I ask, or tell me exactly what to type). Tell me what to check.

## P1 (ask before each)
9. Conflict votes + split day, built from real results.
10. Packages vote: Budget / Sweet spot / Splurge, each with synced flights + a different hotel tier + cost per person + honest trade-offs, all respecting hard limits.
11. Edits by chat: tool-use loop (search_places, search_hotels, search_flights, search_events, submit_itinerary); group-affecting changes go to a vote, personal ones to that person, small ones to a quick 👍/👎.
12. "We're running 2 hours late" → re-plan the rest of today only, keep booked stops, post the updated day card.
13. Bookings checklist ("I'll book this" → "Booked ✅") and settle-up from equalSplit.
