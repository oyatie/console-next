#!/usr/bin/env node
// Bundle budget: gzips every JS chunk of the built SPA, prints the sizes, and fails when the
// initial load (the entry chunk index.html runs plus the chunks it statically imports, i.e. its
// modulepreloads) exceeds the budget. Screens are lazy route chunks, so growth here means
// something eager was added to the sign-in/shell path.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { leakedCopy } from "./bundle-copy.mjs";
import { gzipSync } from "node:zlib";

// Measured 136.7 KB gz after route-level splitting (2026-09-30; one 220.4 KB chunk before); ~10% headroom.
// Screen copy is a per-locale chunk loaded with the first screen (like route chunks, not counted);
// the sign-in and shell copy the entry renders with is in the entry (packages/i18n catalogs/boot.ts).
const INITIAL_BUDGET_KB = 151;
const dist = "apps/web/dist";

const html = readFileSync(path.join(dist, "index.html"), "utf8");
const entry = html.match(/<script type="module"[^>]*src="\/?([^"]+)"/)?.[1];
if (!entry) throw new Error("check-bundle: no module entry script in dist/index.html (run the build first)");
const initial = new Set([entry, ...[...html.matchAll(/rel="modulepreload"[^>]*href="\/?([^"]+\.js)"/g)].map((m) => m[1])]);

const kb = (f) => gzipSync(readFileSync(path.join(dist, f))).length / 1024;
const chunks = readdirSync(path.join(dist, "assets"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ file: `assets/${f}`, kb: kb(`assets/${f}`) }))
  .sort((a, b) => b.kb - a.kb);
for (const c of chunks) console.log(`${c.kb.toFixed(1).padStart(7)} KB gz  ${c.file}${c.file === entry ? "  (entry)" : initial.has(c.file) ? "  (initial)" : ""}`);
const size = chunks.filter((c) => initial.has(c.file)).reduce((n, c) => n + c.kb, 0);
const total = chunks.reduce((n, c) => n + c.kb, 0);
console.log(`initial load ${size.toFixed(1)} KB gz / budget ${INITIAL_BUDGET_KB} KB · all chunks ${total.toFixed(1)} KB gz in ${chunks.length}`);
if (size > INITIAL_BUDGET_KB) {
  console.error(`check-bundle: initial load is ${size.toFixed(1)} KB gz, over the ${INITIAL_BUDGET_KB} KB budget`);
  process.exit(1);
}

// Dev-only gallery copy must not ship: none of its catalog strings may appear in any built chunk.
// Strings the app catalogs also use (e.g. "초안 저장"), alone or inside a longer app string ("Employee roster" in
// "Employee roster Excel file"), legitimately ship, so only gallery-only copy is checked.
const strings = (file) => [...readFileSync(file, "utf8").matchAll(/^\s+"[^"]+": "(.+)",$/gm)].map((m) => m[1]);
const catalogs = "packages/i18n/src/catalogs"; // boot.ts plus the per-namespace ko/*.ts and en/*.ts
const appCopy = readdirSync(catalogs, { recursive: true }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).flatMap((f) => strings(path.join(catalogs, f)));
const galleryFiles = readdirSync("packages/i18n/src").filter((f) => /^gallery.*\.ts$/.test(f)).map((f) => path.join("packages/i18n/src", f));
const galleryCopy = galleryFiles.flatMap(strings).filter((text) => text.length >= 4 && !appCopy.some((app) => app.includes(text)));
if (galleryCopy.length === 0) throw new Error("check-bundle: no gallery strings found to check (packages/i18n/src/gallery.ts moved?)");
const js = readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".js")).map((f) => readFileSync(path.join(dist, "assets", f), "utf8")).join("\n");
const leaked = leakedCopy(js, galleryCopy);
if (leaked.length) {
  console.error(`check-bundle: ${leaked.length} dev-gallery string(s) in the production bundle, e.g. ${JSON.stringify(leaked[0])}`);
  process.exit(1);
}
console.log(`gallery copy: none of ${galleryCopy.length} strings in the bundle`);
