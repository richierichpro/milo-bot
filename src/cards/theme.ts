import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Design tokens copied from the web app (/Users/ris/pakka: app/globals.css,
// app/layout.tsx fonts, lib/format.ts day colours, Tailwind radius/spacing).

export const colors = {
  sand: "#fbf6ee",
  sandDeep: "#f3eadb",
  ink: "#1d2b2c",
  muted: "#5d6b6b",
  teal: "#0f5257",
  tealSoft: "#e3efee",
  marigold: "#f0a202",
  marigoldSoft: "#fdf0d2",
  coral: "#e0603f",
  line: "#e6dccb",
  ok: "#1f7a4d",
  white: "#ffffff",
} as const;

/** Same order as the web app's DAY_COLORS. */
export const DAY_COLORS = ["#0f5257", "#f0a202", "#e0603f", "#6b4c9a", "#2f855a", "#b83280", "#2b6cb0"];
export const AVATAR_COLORS = ["#0f5257", "#f0a202", "#e0603f", "#6b4c9a", "#2f855a", "#b83280"];

/** Tailwind radii used in the app: rounded-xl, rounded-2xl, rounded-full. */
export const radius = { xl: "12px", "2xl": "16px", full: "9999px" } as const;

export const CARD_WIDTH = 1080;

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");
const fontFace = (family: string, file: string, weight: number) =>
  `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;src:url(data:font/ttf;base64,${readFileSync(path.join(FONT_DIR, file)).toString("base64")}) format("truetype");}`;

let fontCss: string | undefined;
/** Rozha One (headings) and Hind (body), embedded so cards render identically offline. */
export function fontsCss(): string {
  return (fontCss ??= [
    fontFace("Rozha One", "RozhaOne-Regular.ttf", 400),
    fontFace("Hind", "Hind-Regular.ttf", 400),
    fontFace("Hind", "Hind-Medium.ttf", 500),
    fontFace("Hind", "Hind-SemiBold.ttf", 600),
    fontFace("Hind", "Hind-Bold.ttf", 700),
  ].join("\n"));
}

const require = createRequire(import.meta.url);
let leaflet: { css: string; js: string } | undefined;
/** Leaflet inlined into the card HTML (the page has no file access). */
export function leafletAssets() {
  if (!leaflet) {
    const dir = path.dirname(require.resolve("leaflet/dist/leaflet.js"));
    leaflet = { css: readFileSync(path.join(dir, "leaflet.css"), "utf8"), js: readFileSync(path.join(dir, "leaflet.js"), "utf8") };
  }
  return leaflet;
}

export const baseCss = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${CARD_WIDTH}px;background:${colors.sand};color:${colors.ink};font-family:"Hind",sans-serif;-webkit-font-smoothing:antialiased}
body{padding:40px}
.display{font-family:"Rozha One",serif;font-weight:400}
.muted{color:${colors.muted}}
.teal{color:${colors.teal}}
.card{background:${colors.white};border:2px solid ${colors.line};border-radius:${radius["2xl"]};overflow:hidden}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:${radius.full};padding:4px 14px;font-size:22px;line-height:1.4}
.eyebrow{font-size:20px;letter-spacing:.2em;text-transform:uppercase;color:${colors.teal}}
.photo{object-fit:cover;background:${colors.sandDeep};display:block}
.brand{display:flex;justify-content:space-between;align-items:center;margin-top:28px;font-size:20px;color:${colors.muted}}
.brand b{font-family:"Rozha One",serif;font-weight:400;font-size:28px;color:${colors.teal}}
`;
