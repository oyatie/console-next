#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Bundle budget: gzips every JS chunk of the built SPA, prints the sizes, and fails when the
// initial load (the entry chunk index.html runs plus the chunks it statically imports, i.e. its
// modulepreloads) exceeds the budget. Screens are lazy route chunks, so growth here means
// something eager was added to the sign-in/shell path.
//
// JRN-FIRSTPAINT (J-HP-4): Also sums each lazy route's chunk set (route chunk + its static imports)
// and checks it against scripts/bundle-budget.json (per page type: shell, list, record, wizard).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { leakedCopy } from "./bundle-copy.mjs";
import { gzipSync } from "node:zlib";

// Measured 136.7 KB gz at the initial gate introduction, with about 10% headroom.
export const INITIAL_BUDGET_KB = 151;
export const DEFAULT_BUDGET_FILE = "scripts/bundle-budget.json";

export const kb = (dist, f) => gzipSync(readFileSync(path.join(dist, f))).length / 1024;

export function checkInitialBudget(dist, budgetKb = INITIAL_BUDGET_KB) {
  const htmlPath = path.join(dist, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const entry = html.match(/<script type="module"[^>]*src="\/?([^"]+)"/)?.[1];
  if (!entry) throw new Error("check-bundle: no module entry script in dist/index.html (run the build first)");
  const initial = new Set([entry, ...[...html.matchAll(/rel="modulepreload"[^>]*href="\/?([^"]+\.js)"/g)].map((m) => m[1])]);

  const chunks = readdirSync(path.join(dist, "assets"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ file: `assets/${f}`, kb: kb(dist, `assets/${f}`) }))
    .sort((a, b) => b.kb - a.kb);

  const size = chunks.filter((c) => initial.has(c.file)).reduce((n, c) => n + c.kb, 0);
  const total = chunks.reduce((n, c) => n + c.kb, 0);

  const ok = size <= budgetKb;
  const error = ok
    ? undefined
    : `check-bundle: initial load is ${size.toFixed(1)} KB gz, over the ${budgetKb} KB budget`;

  return { ok, sizeKb: size, totalKb: total, count: chunks.length, chunks, initial, error };
}

export function checkRouteBudgets(dist, budgetsPathOrObj, options = {}) {
  const budgetConfig = typeof budgetsPathOrObj === "string"
    ? JSON.parse(readFileSync(budgetsPathOrObj, "utf8"))
    : budgetsPathOrObj;

  const manifest = JSON.parse(readFileSync(path.join(dist, ".vite/manifest.json"), "utf8"));
  const { initial } = checkInitialBudget(dist);
  const failures = [];
  const measured = Object.fromEntries(Object.keys(budgetConfig).map(type => [type, { maxKb: 0, chunk: null, chunksCount: 0 }]));
  for (const [source, entry] of Object.entries(manifest)) {
    // Catalogs and third-party utilities are not screens; every local dynamic entry is budgeted explicitly.
    if (!entry.isDynamicEntry || !source.startsWith("src/")) continue;
    const pageType = Object.keys(budgetConfig).find(type => budgetConfig[type].routes.includes(source));
    if (!pageType) {
      failures.push({ route: source, error: `check-bundle: unclassified dynamic screen ${source}; add its page type to ${DEFAULT_BUDGET_FILE}` });
      continue;
    }
    const files = new Set();
    const visit = key => {
      const chunk = manifest[key];
      if (initial.has(chunk.file) || files.has(chunk.file)) return;
      files.add(chunk.file);
      for (const imported of chunk.imports ?? []) visit(imported);
    };
    visit(source);
    const size = [...files].reduce((sum, file) => sum + kb(dist, file), 0);
    const budgetKb = budgetConfig[pageType].budget_kb;
    if (size > measured[pageType].maxKb) measured[pageType] = { maxKb: size, chunk: source, chunksCount: files.size };
    if (size > budgetKb) failures.push({
      route: source, pageType, sizeKb: size, budgetKb,
      error: `check-bundle: route chunk set for ${source} is ${size.toFixed(1)} KB gz, over the ${budgetKb} KB budget for page type '${pageType}'`,
    });
  }

  // Handle --lower flag
  if (options.lower && typeof budgetsPathOrObj === "string") {
    let lowered = false;
    for (const [pt, stats] of Object.entries(measured)) {
      if (stats.maxKb > 0) {
        const rounded = Math.ceil(stats.maxKb);
        const current = typeof budgetConfig[pt] === "number" ? budgetConfig[pt] : budgetConfig[pt]?.budget_kb;
        if (current && rounded < current) {
          if (typeof budgetConfig[pt] === "number") budgetConfig[pt] = rounded;
          else budgetConfig[pt].budget_kb = rounded;
          lowered = true;
          console.log(`lowered budget for ${pt}: ${current} -> ${rounded} KB`);
        }
      }
    }
    if (lowered) {
      writeFileSync(budgetsPathOrObj, JSON.stringify(budgetConfig, null, 2) + "\n", "utf8");
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    failures,
    route: failures[0]?.route,
    sizeKb: failures[0]?.sizeKb,
    budgetKb: failures[0]?.budgetKb,
    error: failures[0]?.error,
    measured,
  };
}

export function checkGalleryCopy(dist) {
  const strings = (file) => [...readFileSync(file, "utf8").matchAll(/^\s+"[^"]+": "(.+)",$/gm)].map((m) => m[1]);
  const catalogs = "packages/i18n/src/catalogs";
  const appCopy = readdirSync(catalogs, { recursive: true })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .flatMap((f) => strings(path.join(catalogs, f)));
  const galleryFiles = readdirSync("packages/i18n/src")
    .filter((f) => /^gallery.*\.ts$/.test(f))
    .map((f) => path.join("packages/i18n/src", f));
  const galleryCopy = galleryFiles.flatMap(strings).filter((text) => text.length >= 4 && !appCopy.some((app) => app.includes(text)));
  if (galleryCopy.length === 0) throw new Error("check-bundle: no gallery strings found to check (packages/i18n/src/gallery.ts moved?)");
  const js = readdirSync(path.join(dist, "assets"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(path.join(dist, "assets", f), "utf8"))
    .join("\n");
  const leaked = leakedCopy(js, galleryCopy);
  return { ok: leaked.length === 0, count: galleryCopy.length, leaked };
}

export function checkBundle(dist = "apps/web/dist", budgetFile = DEFAULT_BUDGET_FILE, options = {}) {
  // 1. Initial bundle budget
  const initResult = checkInitialBudget(dist, INITIAL_BUDGET_KB);
  for (const c of initResult.chunks) {
    console.log(`${c.kb.toFixed(1).padStart(7)} KB gz  ${c.file}${initResult.initial.has(c.file) ? "  (entry)" : ""}`);
  }
  console.log(`initial load ${initResult.sizeKb.toFixed(1)} KB gz / budget ${INITIAL_BUDGET_KB} KB · all chunks ${initResult.totalKb.toFixed(1)} KB gz in ${initResult.count}`);
  if (!initResult.ok) {
    console.error(initResult.error);
    process.exit(1);
  }

  // 2. Route budgets per page type (JRN-FIRSTPAINT / J-HP-4)
  const routeResult = checkRouteBudgets(dist, budgetFile, options);
  console.log("route budgets per page type:");
  for (const [pt, stats] of Object.entries(routeResult.measured)) {
    console.log(`  ${pt.padEnd(8)} ${stats.maxKb.toFixed(1).padStart(5)} KB gz (max: ${stats.chunk ?? "none"})`);
  }
  if (!routeResult.ok) {
    for (const fail of routeResult.failures) {
      console.error(fail.error);
    }
    process.exit(1);
  }

  // 3. Dev-only gallery copy check
  const gallery = checkGalleryCopy(dist);
  if (!gallery.ok) {
    console.error(`check-bundle: ${gallery.leaked.length} dev-gallery string(s) in the production bundle, e.g. ${JSON.stringify(gallery.leaked[0])}`);
    process.exit(1);
  }
  console.log(`gallery copy: none of ${gallery.count} strings in the bundle`);
}

// Run CLI when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const isLower = process.argv.includes("--lower");
  checkBundle("apps/web/dist", DEFAULT_BUDGET_FILE, { lower: isLower });
}
