import { AVATAR_COLORS, CARD_WIDTH, DAY_COLORS, baseCss, colors, fontsCss, leafletAssets, radius } from "./theme.js";

// Every card is plain HTML + CSS built from the web app's tokens. Templates only
// lay out data they're given; they never add facts of their own.

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const rupees = (n: number) => `₹${inr.format(Math.round(n))}`;

const initial = (name: string) => esc(name.trim().slice(0, 1).toUpperCase());
const avatar = (name: string, i: number, size = 52) =>
  `<span style="display:inline-grid;place-items:center;width:${size}px;height:${size}px;border-radius:50%;border:3px solid ${colors.sand};background:${AVATAR_COLORS[i % AVATAR_COLORS.length]};color:#fff;font-weight:700;font-size:${Math.round(size * 0.42)}px">${initial(name)}</span>`;

/** Wraps a card body in a page; `ready` scripts flip window.__ready when images (and maps) are done. */
export function page(body: string, opts: { title?: string; map?: string; extraCss?: string } = {}): string {
  const lf = opts.map ? leafletAssets() : undefined;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.title ?? "Milo")}</title>
<style>${fontsCss()}${baseCss}${lf ? lf.css : ""}${opts.extraCss ?? ""}</style></head>
<body>${body}
<div class="brand"><b>Milo</b><span>planned in your group chat</span></div>
${lf ? `<script>${lf.js}</script>` : ""}
<script>
(function(){
  var imgs=[].slice.call(document.images);
  var imgsDone=Promise.all(imgs.map(function(im){return im.complete?Promise.resolve():new Promise(function(r){im.onload=r;im.onerror=function(){im.style.visibility="hidden";r()}})}));
  var mapDone=Promise.resolve(true);
  ${opts.map ?? ""}
  Promise.race([Promise.all([imgsDone,mapDone]),new Promise(function(r){setTimeout(r,9000)})]).then(function(){document.fonts.ready.then(function(){window.__ready=true})});
})();
</script></body></html>`;
}

const proof = (text: string) => `<p style="margin-top:8px;font-size:19px;color:${colors.muted};font-style:italic">${esc(text)}</p>`;

// ---------- Heard ----------

export type HeardRow = { name: string; city?: string; chips: { label: string; hard: boolean }[] };

export function heardCard(rows: HeardRow[]): string {
  const body = `
<p class="eyebrow">The squad</p>
<h1 class="display" style="font-size:52px;line-height:1.1;margin:6px 0 24px">Everyone's plans, in one place</h1>
<div class="card">${rows
    .map(
      (r, i) => `
  <div style="display:flex;gap:20px;padding:22px 26px;${i ? `border-top:2px solid ${colors.line}` : ""}">
    ${avatar(r.name, i, 60)}
    <div style="flex:1;min-width:0">
      <p style="font-size:28px;font-weight:600">${esc(r.name)}${r.city ? ` <span class="muted" style="font-weight:400">· ${esc(r.city)}</span>` : ""}</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px">${
        r.chips.length
          ? r.chips
              .map((c) =>
                c.hard
                  ? `<span class="pill" style="background:${colors.teal};color:#fff">🔒 ${esc(c.label)}</span>`
                  : `<span class="pill" style="background:${colors.sandDeep};color:${colors.ink}">${esc(c.label)}</span>`,
              )
              .join("")
          : `<span class="pill muted" style="border:2px dashed ${colors.line}">no limits</span>`
      }</div>
    </div>
  </div>`,
    )
    .join("")}
</div>
<p class="muted" style="margin-top:16px;font-size:20px">🔒 = a hard limit Milo will never break without that person's OK</p>`;
  return page(body, { title: "Heard" });
}

// ---------- Destination shortlist ----------

export type ShortlistOption = {
  name: string;
  thumbnail?: string;
  each: number;
  perPerson: { person: string; total: number; within: boolean }[];
  hotelNote?: string;
  mentioned?: boolean;
};

export function shortlistCard(options: ShortlistOption[], note: string): string {
  const n = (o: ShortlistOption) => o.perPerson.filter((p) => p.within).length;
  const body = `
<p class="eyebrow">Where can everyone go?</p>
<h1 class="display" style="font-size:52px;line-height:1.1;margin:6px 0 24px">Your shortlist</h1>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:22px">${options
    .map(
      (o, i) => `
  <div class="card">
    <div style="position:relative">
      ${o.thumbnail ? `<img class="photo" src="${esc(o.thumbnail)}" style="width:100%;height:230px">` : `<div class="photo" style="height:230px"></div>`}
      <span class="pill" style="position:absolute;left:14px;top:14px;background:rgba(255,255,255,.92);color:${colors.teal};font-weight:700">#${i + 1}${o.mentioned ? " · from your chat" : ""}</span>
    </div>
    <div style="padding:18px 22px 22px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
        <p class="display" style="font-size:40px">${esc(o.name)}</p>
        <p style="font-size:26px;font-weight:600;color:${colors.teal}">≈ ${rupees(o.each)} each</p>
      </div>
      <p style="margin-top:8px"><span class="pill" style="background:${n(o) === o.perPerson.length ? "#e6f2ec" : "#fbe9e4"};color:${n(o) === o.perPerson.length ? colors.ok : colors.coral}">${n(o)}/${o.perPerson.length} within budget</span></p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">${o.perPerson
        .map((p) => `<span class="pill" style="font-size:20px;border:2px solid ${p.within ? colors.line : "#f3c3b6"};color:${p.within ? colors.ink : colors.coral}">${esc(p.person)} ${rupees(p.total)}</span>`)
        .join("")}</div>
      ${o.hotelNote ? `<p class="muted" style="margin-top:10px;font-size:19px">${esc(o.hotelNote)}</p>` : ""}
    </div>
  </div>`,
    )
    .join("")}
</div>
${proof(note)}`;
  return page(body, { title: "Shortlist" });
}

// ---------- Vote / Decided ----------

export type VoteOption = { label: string; sub?: string; votes: number; voters: string[]; needsOk?: string; blocked?: boolean };

export function voteCard(question: string, options: VoteOption[], footer: string): string {
  const max = Math.max(1, ...options.map((o) => o.votes));
  const body = `
<p class="eyebrow">🗳 Squad vote</p>
<h1 class="display" style="font-size:50px;line-height:1.1;margin:6px 0 24px">${esc(question)}</h1>
<div class="card">${options
    .map(
      (o, i) => `
  <div style="padding:22px 26px;${i ? `border-top:2px solid ${colors.line}` : ""};${o.blocked ? "opacity:.45" : ""}">
    <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
      <p style="font-size:30px;font-weight:600">${String.fromCharCode(65 + i)} · ${esc(o.label)}</p>
      <p style="font-size:28px;font-weight:700;color:${colors.teal}">${o.votes}</p>
    </div>
    ${o.sub ? `<p class="muted" style="font-size:22px;margin-top:4px">${esc(o.sub)}</p>` : ""}
    ${o.needsOk ? `<p style="font-size:22px;margin-top:6px;color:${colors.coral}">⚠ needs ${esc(o.needsOk)}'s OK</p>` : ""}
    <div style="height:12px;border-radius:9999px;background:${colors.sandDeep};margin-top:12px;overflow:hidden"><div style="height:100%;width:${(o.votes / max) * 100}%;background:${colors.marigold}"></div></div>
    <p class="muted" style="font-size:20px;margin-top:8px">${o.voters.length ? esc(o.voters.join(" · ")) : "no votes yet"}</p>
  </div>`,
    )
    .join("")}
</div>
${proof(footer)}`;
  return page(body, { title: "Vote" });
}

export function decidedCard(question: string, winner: string, detail: string, reason: string): string {
  const body = `
<p class="eyebrow">✅ Decided</p>
<p class="muted" style="font-size:26px;margin-top:6px">${esc(question)}</p>
<div class="card" style="margin-top:20px;padding:34px 36px;border-color:${colors.teal}">
  <p class="display" style="font-size:72px;line-height:1.05;color:${colors.teal}">${esc(winner)}</p>
  <p style="font-size:26px;margin-top:10px">${esc(detail)}</p>
</div>
${proof(reason)}`;
  return page(body, { title: "Decided" });
}

// ---------- Plan header ----------

export type HeaderData = {
  title: string;
  destination: string;
  dates: string;
  perPerson: number;
  summary: string;
  squad: string[];
  verified: { verified: number; total: number };
  searches: number;
};

export function headerCard(h: HeaderData): string {
  const allOk = h.verified.verified === h.verified.total;
  const body = `
<p class="eyebrow">${esc(h.destination)} · ${esc(h.dates)}</p>
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-top:6px">
  <h1 class="display" style="font-size:56px;line-height:1.08;flex:1">${esc(h.title)}</h1>
  <div style="text-align:right">
    <p class="display" style="font-size:56px;color:${colors.teal};line-height:1">${rupees(h.perPerson)}</p>
    <p class="muted" style="font-size:20px">per person, on average</p>
  </div>
</div>
<p style="font-size:24px;line-height:1.45;margin-top:16px;color:#3b4747">${esc(h.summary)}</p>
<div style="display:flex;align-items:center;gap:18px;margin-top:22px;flex-wrap:wrap">
  <div style="display:flex">${h.squad.map((n, i) => `<span style="margin-left:${i ? -12 : 0}px">${avatar(n, i)}</span>`).join("")}</div>
  <span class="pill" style="background:${allOk ? "#e6f2ec" : "#fbe9e4"};color:${allOk ? colors.ok : colors.coral};font-weight:600">✓ ${h.verified.verified}/${h.verified.total} verified with live Google data</span>
  <span class="pill" style="background:${colors.white};border:2px solid ${colors.line}">${h.searches} searches</span>
</div>`;
  return page(body, { title: "Plan" });
}

// ---------- Flights + arrival timeline ----------

export type FlightLeg = { from: string; to: string; depart: string; arrive: string; nextDay: boolean; airline: string; logo?: string; duration: string; stops: string; price: number; numbers: string };
export type FlightRow = { person: string; city: string; out?: FlightLeg; back?: FlightLeg; checked?: string };
export type ArrivalDot = { person: string; time: string; minutes: number; airport: string };

function legRow(l: FlightLeg | undefined, label: string): string {
  if (!l) return `<p class="muted" style="font-size:22px">${label}: couldn't check this</p>`;
  return `<div style="display:flex;align-items:center;gap:12px;font-size:23px;margin-top:6px">
    <span class="muted" style="width:60px;font-size:18px;letter-spacing:.08em;text-transform:uppercase">${label}</span>
    ${l.logo ? `<img src="${esc(l.logo)}" style="width:28px;height:28px;border-radius:6px">` : ""}
    <span style="font-weight:600">${esc(l.from)} ${esc(l.depart)} → ${esc(l.to)} ${esc(l.arrive)}${l.nextDay ? `<sup style="color:${colors.coral}">+1</sup>` : ""}</span>
    <span class="muted">· ${esc(l.duration)} · ${esc(l.stops)}</span>
    <span style="margin-left:auto;font-weight:600">${rupees(l.price)}</span>
  </div>`;
}

export function flightsCard(destination: string, rows: FlightRow[], arrivals: ArrivalDot[], window?: { headline: string; sub: string; warning?: string }): string {
  const lo = Math.min(...arrivals.map((a) => a.minutes)) - 60;
  const hi = Math.max(...arrivals.map((a) => a.minutes)) + 60;
  const pct = (m: number) => ((m - lo) / Math.max(1, hi - lo)) * 100;
  // Stack labels in rows so none overlap (same rule as the web app).
  const LABEL = 24;
  const rowEnds: number[] = [];
  const labelRow = arrivals
    .map((a, i) => ({ p: pct(a.minutes), i }))
    .sort((x, y) => x.p - y.p)
    .reduce<number[]>((rows, { p, i }) => {
      let r = rowEnds.findIndex((end) => p - LABEL / 2 >= end);
      if (r < 0) r = rowEnds.push(0) - 1;
      rowEnds[r] = p + LABEL / 2;
      rows[i] = r;
      return rows;
    }, []);
  const lines = Math.max(1, ...labelRow.map((r) => r + 1));
  const first = Math.min(...arrivals.map((a) => a.minutes));
  const last = Math.max(...arrivals.map((a) => a.minutes));

  const timeline =
    arrivals.length > 1 && window
      ? `<div class="card" style="padding:24px 28px;margin-bottom:22px">
    <p style="font-size:26px;font-weight:600">${esc(window.headline)} <span class="muted" style="font-weight:400">· ${esc(window.sub)}</span></p>
    ${window.warning ? `<p style="font-size:22px;font-weight:600;color:${colors.coral};margin-top:6px">⚠ ${esc(window.warning)}</p>` : ""}
    <div style="position:relative;height:14px;border-radius:9999px;background:${colors.sandDeep};margin-top:30px">
      <div style="position:absolute;top:0;bottom:0;left:${pct(first)}%;right:${100 - pct(last)}%;border-radius:9999px;background:rgba(240,162,2,.5)"></div>
      ${arrivals.map((a) => `<div style="position:absolute;left:${pct(a.minutes)}%;top:-7px;width:28px;height:28px;margin-left:-14px;border-radius:50%;border:4px solid #fff;background:${colors.teal};box-shadow:0 1px 4px rgba(0,0,0,.25)"></div>`).join("")}
    </div>
    <div style="position:relative;height:${lines * 30}px;margin-top:16px">${arrivals
      .map((a, i) => `<p style="position:absolute;white-space:nowrap;transform:translateX(-50%);left:${Math.min(88, Math.max(12, pct(a.minutes)))}%;top:${labelRow[i] * 30}px;font-size:20px"><b>${esc(a.person)}</b> ${esc(a.time)} <span class="muted">${esc(a.airport)}</span></p>`)
      .join("")}</div>
  </div>`
      : "";

  const body = `
<p class="eyebrow">✈️ Flights</p>
<h1 class="display" style="font-size:48px;margin:6px 0 22px">Everyone to ${esc(destination)}</h1>
${timeline}
<div class="card">${rows
    .map(
      (r, i) => `
  <div style="padding:20px 26px;${i ? `border-top:2px solid ${colors.line}` : ""}">
    <p style="font-size:24px"><b>${esc(r.person)}</b> <span class="muted">· ${esc(r.city)} → ${esc(destination)}</span></p>
    ${legRow(r.out, "Out")}
    ${legRow(r.back, "Back")}
    ${r.out ? proof(`Google Flights · ${r.out.numbers}${r.checked ? ` · checked ${r.checked}` : ""}`) : ""}
  </div>`,
    )
    .join("")}
</div>`;
  return page(body, { title: "Flights" });
}

// ---------- Hotel ----------

export type HotelData = { name: string; photo?: string; stars?: number; rating?: number; reviews?: number; perNight?: number; rooms: number; nights: number; distanceKm?: number; checkIn?: string; checkOut?: string; amenities: string[]; checked?: string };

const ratingHtml = (rating?: number, reviews?: number) =>
  rating ? `<span><span style="color:${colors.marigold}">★</span> ${rating.toFixed(1)}${reviews ? ` <span class="muted">(${inr.format(reviews)})</span>` : ""}</span>` : "";

export function hotelCard(h: HotelData): string {
  const body = `
<p class="eyebrow">🏨 Where you'll stay</p>
<div class="card" style="display:flex;margin-top:18px">
  ${h.photo ? `<img class="photo" src="${esc(h.photo)}" style="width:360px;min-height:300px">` : `<div class="photo" style="width:360px;min-height:300px"></div>`}
  <div style="flex:1;min-width:0;padding:26px 28px">
    <p class="display" style="font-size:38px;line-height:1.15">${esc(h.name)}</p>
    <p style="font-size:23px;margin-top:8px;display:flex;gap:14px;flex-wrap:wrap">${h.stars ? `<span class="muted">${"★".repeat(h.stars)} hotel</span>` : ""}${ratingHtml(h.rating, h.reviews)}</p>
    <p style="font-size:24px;margin-top:10px"><b>${h.perNight ? rupees(h.perNight) : "–"}</b><span class="muted"> /night · ${h.rooms} room${h.rooms > 1 ? "s" : ""} × ${h.nights} nights</span></p>
    ${h.distanceKm !== undefined ? `<p class="muted" style="font-size:22px;margin-top:8px">📍 ≈ ${h.distanceKm < 1 ? "<1" : Math.round(h.distanceKm)} km from most of your plan</p>` : ""}
    ${h.checkIn || h.checkOut ? `<p class="muted" style="font-size:22px;margin-top:6px">Check-in ${esc(h.checkIn ?? "not listed")} · check-out ${esc(h.checkOut ?? "not listed")}</p>` : ""}
    ${h.amenities.length ? `<p class="muted" style="font-size:20px;margin-top:8px">${esc(h.amenities.slice(0, 4).join(" · "))}</p>` : ""}
    ${proof(`Google Hotels${h.checked ? ` · checked ${h.checked}` : ""}`)}
  </div>
</div>`;
  return page(body, { title: "Hotel" });
}

// ---------- Hotel choice (one card, three stays) ----------

export type HotelChoice = { number: number; tag: string; name: string; photo?: string; rating?: number; reviews?: number; stars?: number; perNight?: number; each: number };

export function hotelChoiceCard(options: HotelChoice[], nights: number, rooms: number): string {
  const rows = options
    .map(
      (h) => `
<div class="card" style="display:flex;margin-top:18px">
  ${h.photo ? `<img class="photo" src="${esc(h.photo)}" style="width:260px;min-height:210px">` : `<div class="photo" style="width:260px;min-height:210px"></div>`}
  <div style="flex:1;min-width:0;padding:20px 26px">
    <p style="font-size:22px;letter-spacing:.08em;text-transform:uppercase" class="muted"><b style="color:${colors.teal}">${h.number}</b> · ${esc(h.tag)}</p>
    <p class="display" style="font-size:32px;line-height:1.15;margin-top:4px">${esc(h.name)}</p>
    <p style="font-size:22px;margin-top:6px;display:flex;gap:14px;flex-wrap:wrap">${h.stars ? `<span class="muted">${"★".repeat(h.stars)} hotel</span>` : ""}${ratingHtml(h.rating, h.reviews)}</p>
    <p style="font-size:23px;margin-top:8px"><b>${h.perNight ? rupees(h.perNight) : "–"}</b><span class="muted"> /night</span> · <b>≈ ${rupees(h.each)}</b><span class="muted"> each, all in</span></p>
  </div>
</div>`,
    )
    .join("");
  const body = `
<p class="eyebrow">🏨 Pick your stay</p>
<h1 class="display" style="font-size:46px;line-height:1.1;margin:6px 0 4px">Three stays that fit everyone</h1>
<p class="muted" style="font-size:22px">${rooms} room${rooms > 1 ? "s" : ""} × ${nights} nights · "each" = flights + your share of the room</p>
${rows}
${proof("Google Hotels")}`;
  return page(body, { title: "Pick your stay" });
}

// ---------- Day ----------

export type DayStop = {
  time: string;
  name: string;
  category?: string;
  rating?: number;
  reviews?: number;
  price?: string;
  note?: string;
  photo?: string;
  proof: string;
  lat?: number;
  lng?: number;
  /** "≈ 2 km, short ride" or "18 min by scooter" before this stop. */
  hop?: string;
  kind?: "stop" | "logistics";
};

export type DayData = { index: number; date: string; title: string; stops: DayStop[]; leaveBy?: string; travel?: string; hotel?: { lat: number; lng: number; name: string } };

export function dayCard(d: DayData, opts: { withMap?: boolean } = {}): string {
  const color = DAY_COLORS[d.index % DAY_COLORS.length];
  const mapped = d.stops.filter((s) => s.kind !== "logistics" && s.lat !== undefined && s.lng !== undefined);
  const withMap = (opts.withMap ?? true) && mapped.length > 0;
  let n = 0;
  const stops = d.stops
    .map((s) => {
      if (s.kind === "logistics") {
        return `<div style="display:flex;gap:16px;align-items:center;padding:12px 4px;font-size:22px"><span style="width:76px;font-weight:600">${esc(s.time)}</span><span class="muted">${esc(s.name)}</span></div>`;
      }
      n++;
      return `${s.hop ? `<p class="muted" style="font-size:19px;padding:2px 0 8px 92px">↓ ${esc(s.hop)}</p>` : ""}
<div class="card" style="display:flex;gap:18px;padding:18px;margin-bottom:12px">
  <div style="width:76px;display:flex;flex-direction:column;align-items:center;gap:8px">
    <span style="font-size:23px;font-weight:600">${esc(s.time)}</span>
    <span style="display:grid;place-items:center;width:38px;height:38px;border-radius:50%;border:3px solid #fff;background:${color};color:#fff;font-weight:700;font-size:19px;box-shadow:0 1px 4px rgba(0,0,0,.3)">${n}</span>
  </div>
  ${s.photo ? `<img class="photo" src="${esc(s.photo)}" style="width:150px;height:150px;border-radius:${radius.xl}">` : `<div class="photo" style="width:150px;height:150px;border-radius:${radius.xl}"></div>`}
  <div style="flex:1;min-width:0">
    <p style="font-size:27px;font-weight:600;line-height:1.2">${esc(s.name)}</p>
    <p class="muted" style="font-size:21px;margin-top:4px;display:flex;gap:12px;flex-wrap:wrap">${s.category ? `<span>${esc(s.category)}</span>` : ""}${ratingHtml(s.rating, s.reviews)}${s.price ? `<span>${esc(s.price)}</span>` : ""}</p>
    ${s.note ? `<p style="font-size:21px;margin-top:6px;color:#3b4747"><span class="teal">Milo's note:</span> ${esc(s.note)}</p>` : ""}
    ${proof(s.proof)}
  </div>
</div>`;
    })
    .join("");

  const markers = mapped.map((s, i) => ({ lat: s.lat!, lng: s.lng!, n: i + 1 }));
  const map = withMap
    ? `mapDone=new Promise(function(done){
  try{
    var m=L.map("map",{zoomControl:false,attributionControl:true,fadeAnimation:false,zoomAnimation:false});
    var pts=${JSON.stringify(markers)}, hotel=${JSON.stringify(d.hotel ?? null)};
    var tiles=L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:17,attribution:"© OpenStreetMap contributors"}).addTo(m);
    var all=pts.map(function(p){return [p.lat,p.lng]});
    if(hotel){all.push([hotel.lat,hotel.lng]);L.marker([hotel.lat,hotel.lng],{icon:L.divIcon({className:"",html:'<div class="pin-hotel">🏨</div>',iconSize:[44,44],iconAnchor:[22,22]})}).addTo(m)}
    L.polyline(pts.map(function(p){return [p.lat,p.lng]}),{color:"${color}",weight:5,opacity:.85}).addTo(m);
    pts.forEach(function(p){L.marker([p.lat,p.lng],{icon:L.divIcon({className:"",html:'<div class="pin" style="background:${color}">'+p.n+'</div>',iconSize:[36,36],iconAnchor:[18,18]})}).addTo(m)});
    m.fitBounds(L.latLngBounds(all),{padding:[48,48],maxZoom:14});
    var t=setTimeout(function(){window.__mapFailed=true;done(false)},7000);
    tiles.on("load",function(){clearTimeout(t);done(true)});
    tiles.on("tileerror",function(){window.__mapFailed=true});
  }catch(e){window.__mapFailed=true;done(false)}
});`
    : "";

  const body = `
<div style="display:flex;align-items:center;gap:14px">
  <span style="width:20px;height:20px;border-radius:50%;background:${color}"></span>
  <p class="eyebrow" style="color:${color}">Day ${d.index + 1} · ${esc(d.date)}</p>
</div>
<h1 class="display" style="font-size:50px;line-height:1.1;margin:6px 0 10px">${esc(d.title)}</h1>
<p class="muted" style="font-size:22px;margin-bottom:20px">${[d.leaveBy ? `Leave hotel by <b style="color:${colors.ink}">${esc(d.leaveBy)}</b>` : "", d.travel ? `🚗 ${esc(d.travel)} travel today` : ""].filter(Boolean).join(" · ")}</p>
${withMap ? `<div id="map" style="height:430px;border-radius:${radius["2xl"]};border:2px solid ${colors.line};margin-bottom:22px;overflow:hidden"></div>` : ""}
${stops || `<p class="card muted" style="padding:22px;font-size:22px;border-style:dashed">A free day: nothing planned.</p>`}`;
  const css = `.pin{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;border:3px solid #fff;color:#fff;font:700 17px Hind,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35)}
.pin-hotel{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:#fff;border:3px solid ${colors.marigold};font-size:22px;box-shadow:0 2px 6px rgba(0,0,0,.35)}
.leaflet-container{background:${colors.sandDeep};font-family:Hind,sans-serif}`;
  return page(body, { title: `Day ${d.index + 1}`, map: map || undefined, extraCss: css });
}

// ---------- Boarding pass ----------

export type PassCheck = { ok: boolean; waived?: string; text: string };
export type PassData = {
  person: string;
  index: number;
  destination: string;
  dates: string;
  out?: { from: string; to: string; depart: string; arrive: string; date: string; numbers: string; airline: string };
  back?: { from: string; to: string; depart: string; date: string; numbers: string };
  hotel?: string;
  total: number;
  checks: PassCheck[];
};

export function boardingPassCard(p: PassData): string {
  const accent = AVATAR_COLORS[p.index % AVATAR_COLORS.length];
  const o = p.out;
  const body = `
<div style="border-radius:24px;overflow:hidden;background:#fff;border:2px solid ${colors.line};box-shadow:0 4px 18px rgba(29,43,44,.08)">
  <div style="background:${colors.teal};color:#fff;padding:22px 32px;display:flex;justify-content:space-between;align-items:center">
    <span class="display" style="font-size:34px">Milo</span>
    <span style="font-size:20px;letter-spacing:.24em">BOARDING PASS</span>
  </div>
  <div style="padding:30px 36px 26px">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><p class="muted" style="font-size:18px;letter-spacing:.14em">PASSENGER</p><p class="display" style="font-size:44px;color:${accent}">${esc(p.person)}</p></div>
      <div style="text-align:right"><p class="muted" style="font-size:18px;letter-spacing:.14em">TRIP</p><p style="font-size:26px;font-weight:600">${esc(p.destination)} · ${esc(p.dates)}</p></div>
    </div>
    ${
      o
        ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:24px">
      <div><p class="display" style="font-size:96px;line-height:1">${esc(o.from)}</p><p style="font-size:26px;font-weight:600;font-family:monospace">${esc(o.depart)}</p></div>
      <div style="flex:1;text-align:center;color:${colors.muted};font-size:22px">
        <div style="border-top:3px dashed ${colors.line};margin:0 24px;position:relative;top:22px"></div>
        <span style="position:relative;background:#fff;padding:0 12px;font-size:40px">✈️</span>
        <p style="margin-top:4px">${esc(o.airline)} · ${esc(o.numbers)}</p>
      </div>
      <div style="text-align:right"><p class="display" style="font-size:96px;line-height:1">${esc(o.to)}</p><p style="font-size:26px;font-weight:600;font-family:monospace">${esc(o.arrive)}</p></div>
    </div>
    <p class="muted" style="font-size:22px;margin-top:10px">${esc(o.date)}${p.back ? ` · home ${esc(p.back.date)}, ${esc(p.back.from)} ${esc(p.back.depart)} → ${esc(p.back.to)} (${esc(p.back.numbers)})` : ""}</p>`
        : `<p class="muted" style="font-size:24px;margin-top:20px">Flights: couldn't check this</p>`
    }
  </div>
  <div style="position:relative;height:0;border-top:3px dashed ${colors.line};margin:0 30px">
    <span style="position:absolute;left:-52px;top:-22px;width:44px;height:44px;border-radius:50%;background:${colors.sand}"></span>
    <span style="position:absolute;right:-52px;top:-22px;width:44px;height:44px;border-radius:50%;background:${colors.sand}"></span>
  </div>
  <div style="padding:26px 36px 30px;background:${colors.sand}">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <p class="eyebrow" style="color:${colors.ok}">Works for you</p>
      <p style="font-size:26px;font-weight:700">${rupees(p.total)} <span class="muted" style="font-weight:400;font-size:20px">your share</span></p>
    </div>
    <div style="margin-top:12px">${p.checks
      .map(
        (c) => `<p style="font-size:23px;line-height:1.4;margin-top:8px;display:flex;gap:10px"><span style="color:${c.waived ? colors.coral : c.ok ? colors.ok : colors.coral};font-weight:700">${c.waived ? "⚠" : c.ok ? "✓" : "✗"}</span><span>${esc(c.text)}${c.waived ? ` <span style="color:${colors.coral}">(you agreed: ${esc(c.waived)})</span>` : ""}</span></p>`,
      )
      .join("")}</div>
    ${p.hotel ? `<p class="muted" style="font-size:20px;margin-top:14px">🏨 ${esc(p.hotel)}</p>` : ""}
  </div>
</div>`;
  return page(body, { title: `Pass · ${p.person}` });
}

// ---------- Cost split ----------

export type CostRow = { person: string; flights: number; hotelShare: number; total: number; budget?: number };

export function costSplitCard(rows: CostRow[], nights: number, rooms: number, extra?: string): string {
  const avg = rows.reduce((s, r) => s + r.total, 0) / Math.max(1, rows.length);
  const th = `style="padding:16px 22px;text-align:right;font-weight:500"`;
  const body = `
<p class="eyebrow">💸 Cost split</p>
<h1 class="display" style="font-size:48px;margin:6px 0 22px">What each person pays</h1>
<div class="card">
  <table style="width:100%;border-collapse:collapse;font-size:24px">
    <thead style="background:rgba(243,234,219,.6);color:${colors.muted}"><tr><th style="padding:16px 22px;text-align:left;font-weight:500">Who</th><th ${th}>Flights</th><th ${th}>Hotel share</th><th ${th}>Total</th></tr></thead>
    <tbody>${rows
      .map((r) => {
        const over = r.budget !== undefined && r.total > r.budget;
        return `<tr style="border-top:2px solid ${colors.line}"><td style="padding:16px 22px">${esc(r.person)}${r.budget ? ` <span class="muted" style="font-size:19px">cap ${rupees(r.budget)}</span>` : ""}</td><td style="padding:16px 22px;text-align:right">${rupees(r.flights)}</td><td style="padding:16px 22px;text-align:right">${rupees(r.hotelShare)}</td><td style="padding:16px 22px;text-align:right;font-weight:700;color:${over ? colors.coral : colors.ink}">${rupees(r.total)}</td></tr>`;
      })
      .join("")}</tbody>
  </table>
  <p class="muted" style="padding:14px 22px;font-size:19px;border-top:2px solid ${colors.line}">Hotel share = price per night × ${nights} nights × ${rooms} rooms ÷ ${rows.length} people. Average ${rupees(avg)}.${extra ? ` ${esc(extra)}` : ""}</p>
</div>`;
  return page(body, { title: "Cost split" });
}

export { CARD_WIDTH };
