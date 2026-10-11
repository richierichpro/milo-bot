// Renders every card from the demo squad's real Goa data into a folder, for eyeballing.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeRenderer, renderCard } from "../src/cards/render.js";
import { buildSampleCards } from "../tests/support/sample-cards.js";

const out = process.argv[2] ?? "/tmp/milo-cards";
await mkdir(out, { recursive: true });
for (const [name, html, withoutMap] of await buildSampleCards()) {
  const r = await renderCard(html, withoutMap);
  await writeFile(path.join(out, `${name}.png`), r.png);
  console.log(`${name}: ${r.width}×${r.height}${r.scrollWidth > 1080 ? ` ⚠ overflows (${r.scrollWidth}px)` : ""}${r.mapFailed ? " (map failed → rendered without)" : ""}`);
}
await closeRenderer();
