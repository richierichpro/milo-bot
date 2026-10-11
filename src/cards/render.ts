import { chromium, type Browser } from "playwright";
import { CARD_WIDTH } from "./theme.js";

// One shared headless Chromium renders every card: HTML in, PNG out.

let browser: Promise<Browser> | undefined;
const getBrowser = () => (browser ??= chromium.launch());

export type Rendered = { png: Buffer; width: number; height: number; scrollWidth: number; mapFailed: boolean };

declare global {
  interface Window {
    __ready?: boolean;
    __mapFailed?: boolean;
  }
}

export async function renderHtml(html: string, opts: { timeoutMs?: number } = {}): Promise<Rendered> {
  const ctx = await (await getBrowser()).newContext({ viewport: { width: CARD_WIDTH, height: 100 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 20_000 });
    await page.waitForFunction(() => window.__ready === true, undefined, { timeout: opts.timeoutMs ?? 20_000 });
    const { height, scrollWidth, mapFailed } = await page.evaluate(() => ({
      height: Math.ceil(document.documentElement.scrollHeight),
      scrollWidth: Math.ceil(document.documentElement.scrollWidth),
      mapFailed: window.__mapFailed === true,
    }));
    await page.setViewportSize({ width: CARD_WIDTH, height });
    const png = await page.screenshot({ type: "png", fullPage: true });
    return { png, width: CARD_WIDTH * 2, height: height * 2, scrollWidth, mapFailed };
  } finally {
    await ctx.close();
  }
}

/** Renders a card; if it has a map whose tiles fail, renders the fallback (same card without the map). */
export async function renderCard(html: string, withoutMap?: () => string): Promise<Rendered> {
  const r = await renderHtml(html);
  return r.mapFailed && withoutMap ? renderHtml(withoutMap()) : r;
}

export async function closeRenderer() {
  if (browser) await (await browser).close();
  browser = undefined;
}
