#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Bundle budget: gzips every JS chunk of the built SPA, prints the sizes, and fails when the
// initial load (the entry chunk index.html runs plus the chunks it statically imports, i.e. its
// modulepreloads) exceeds the budget. Screens are lazy route chunks, so growth here means
// something eager was added to the entry. Sign-in also budgets its awaited catalog chunks.
//
// JRN-FIRSTPAINT (J-HP-4): Also sums each lazy route's chunk set (route chunk + its static imports)
// and checks it against scripts/bundle-budget.json (per page type: shell, list, record, wizard).
//
// CSS is counted beside the JS and has its own budgets: one for the stylesheets the first page links, and one per
// page type (css_budget_kb in the budget file) for the route that loads the most CSS beyond them.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { leakedCopy } from "./bundle-copy.mjs";
import { gzipSync } from "node:zlib";

// Clean dev dadcc1f7c9: raw 148.6640625 KB gz, hash-normalised 145.0751953125 KB gz.
// Preserve strictness: 148.8 - (148.6640625 - 145.0751953125) = 145.2111328125; floor to 0.001 KB.
export const INITIAL_BUDGET_KB = 145.211;
// The first page's stylesheets measured 21.1 KB gz when CSS was first counted; the budget leaves about a fifth above
// that for a second visual style's values.
export const INITIAL_CSS_BUDGET_KB = 26;
export const DEFAULT_BUDGET_FILE = "scripts/bundle-budget.json";

// Saved views must keep the record and its command forms behind record navigation.
const orgTabs = "src/routes/org-tabs.tsx";
const orgLists = new Set(["src/features/org/ui/org-changes.tsx", "src/features/org-bulk/ui/history-page.tsx"]);
const orgRecord = "src/features/org/OrgChange.tsx";

export const kb = (dist, f) => gzipSync(readFileSync(path.join(dist, f))).length / 1024;

export function checkInitialBudget(dist, budgetKb = INITIAL_BUDGET_KB, cssBudgetKb = INITIAL_CSS_BUDGET_KB) {
  const htmlPath = path.join(dist, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const entry = html.match(/<script type="module"[^>]*src="\/?([^"]+)"/)?.[1];
  if (!entry) throw new Error("check-bundle: no module entry script in dist/index.html (run the build first)");
  const initial = new Set([entry, ...[...html.matchAll(/rel="modulepreload"[^>]*href="\/?([^"]+\.js)"/g)].map((m) => m[1])]);

  const chunks = readdirSync(path.join(dist, "assets"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => {
      const file = `assets/${f}`;
      // Hash churn changes gzip entropy without changing the code delivered on first paint.
      const bytes = initial.has(file)
        ? Buffer.from(readFileSync(path.join(dist, file), "latin1").replace(/-[A-Za-z0-9_-]{8}\.(js|css)/g, "-HASHHASH.$1"), "latin1")
        : readFileSync(path.join(dist, file));
      return { file, kb: gzipSync(bytes).length / 1024 };
    })
    .sort((a, b) => b.kb - a.kb);

  // The stylesheets the document itself links: what the first page pays for in CSS.
  const sheets = new Set([...html.matchAll(/rel="stylesheet"[^>]*href="\/?([^"]+\.css)"/g)].map((m) => m[1]));
  const cssKb = [...sheets].reduce((n, f) => n + kb(dist, f), 0);
  const size = chunks.filter((c) => initial.has(c.file)).reduce((n, c) => n + c.kb, 0);
  const total = chunks.reduce((n, c) => n + c.kb, 0);

  const ok = size <= budgetKb && cssKb <= cssBudgetKb;
  const error = size > budgetKb
    ? `check-bundle: initial load is ${size.toFixed(1)} KB gz, over the ${budgetKb} KB budget`
    : cssKb > cssBudgetKb
      ? `check-bundle: the first page's CSS is ${cssKb.toFixed(1)} KB gz, over the ${cssBudgetKb} KB CSS budget`
      : undefined;

  return { ok, sizeKb: size, totalKb: total, count: chunks.length, chunks, initial, sheets, cssKb, error };
}

export function checkRouteBudgets(dist, budgetsPathOrObj, options = {}) {
  const budgetConfig = typeof budgetsPathOrObj === "string"
    ? JSON.parse(readFileSync(budgetsPathOrObj, "utf8"))
    : budgetsPathOrObj;

  const manifest = JSON.parse(readFileSync(path.join(dist, ".vite/manifest.json"), "utf8"));
  const { initial, sheets } = checkInitialBudget(dist);
  const failures = [];
  const measured = Object.fromEntries(Object.keys(budgetConfig).map(type => [type, { maxKb: 0, chunk: null, chunksCount: 0, maxCssKb: 0, cssChunk: null, cssBudgetKb: budgetConfig[type].css_budget_kb }]));
  const deferred = new Set(Object.values(budgetConfig).flatMap(config => config.deferred ?? []));
  for (const source of deferred) {
    if (!manifest[source]?.isDynamicEntry) failures.push({ error: `check-bundle: ${source} must have its own dynamic entry` });
  }
  for (const source of [orgTabs, ...orgLists]) {
    if (!manifest[source]?.isDynamicEntry) failures.push({ route: source, error: `check-bundle: ${source} must have its own dynamic entry` });
    // The tabs module also declares the lazy record route; the list screens never load it themselves.
    if (orgLists.has(source) && manifest[source]?.dynamicImports?.includes(orgRecord)) failures.push({ route: source, error: `check-bundle: ${source} dynamically imports ${orgRecord}; load it on record navigation` });
  }
  for (const [source, entry] of Object.entries(manifest)) {
    // Catalogs and third-party utilities are not screens; every local dynamic entry is budgeted explicitly.
    if (!entry.isDynamicEntry || !source.startsWith("src/") || deferred.has(source)) continue;
    const pageType = Object.keys(budgetConfig).find(type => budgetConfig[type].routes.includes(source));
    if (!pageType) {
      failures.push({ route: source, error: `check-bundle: unclassified dynamic screen ${source}; add its page type to ${DEFAULT_BUDGET_FILE}` });
      continue;
    }
    const files = new Set();
    const css = new Set();
    const visit = key => {
      const chunk = manifest[key];
      if (initial.has(chunk.file) || files.has(chunk.file)) return;
      files.add(chunk.file);
      // A chunk names every stylesheet it needs; the first page's are already loaded.
      for (const sheet of chunk.css ?? []) if (!sheets.has(sheet)) css.add(sheet);
      for (const imported of chunk.imports ?? []) visit(imported);
    };
    visit(source);
    // The default directory starts its authorized row read while its mandatory table layout loads.
    if (source === "src/features/people/ui/people-route.tsx" && manifest["src/features/people/ui/roster-screen.tsx"]) {
      visit("src/features/people/ui/roster-screen.tsx");
    }
    if (source === orgTabs || orgLists.has(source)) {
      if (!manifest[orgRecord]?.isDynamicEntry) failures.push({ route: source, error: `check-bundle: ${orgRecord} must have its own dynamic entry` });
      for (const [key, chunk] of Object.entries(manifest)) {
        if ((key === orgRecord || chunk.name === "effectuate-consequence") && (files.has(chunk.file) || initial.has(chunk.file))) failures.push({
          route: source, error: `check-bundle: ${key} is statically loaded by ${source}; load it on record navigation`,
        });
      }
    }
    for (const interaction of budgetConfig[pageType].deferred ?? []) {
      const file = manifest[interaction]?.file;
      if (file && (files.has(file) || initial.has(file))) failures.push({
        route: source, error: `check-bundle: ${interaction} is statically loaded by ${source}; load it on interaction`,
      });
    }
    const size = [...files].reduce((sum, file) => sum + kb(dist, file), 0);
    const budgetKb = budgetConfig[pageType].budget_kb;
    if (size > measured[pageType].maxKb) Object.assign(measured[pageType], { maxKb: size, chunk: source, chunksCount: files.size });
    const cssSize = [...css].reduce((sum, file) => sum + kb(dist, file), 0);
    if (cssSize > measured[pageType].maxCssKb) Object.assign(measured[pageType], { maxCssKb: cssSize, cssChunk: source });
    const cssBudgetKb = budgetConfig[pageType].css_budget_kb;
    if (cssBudgetKb !== undefined && cssSize > cssBudgetKb) failures.push({
      route: source, pageType, sizeKb: cssSize, budgetKb: cssBudgetKb,
      error: `check-bundle: CSS for ${source} is ${cssSize.toFixed(1)} KB gz, over the ${cssBudgetKb} KB CSS budget for page type '${pageType}'`,
    });
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

/** Sign-in's additional blocking chunks share the existing shell budget, including awaited copy. */
export function checkSignInBudget(dist, budgetsPathOrObj, sources = Object.fromEntries(
  ["src/routes/app.ts", "src/main.tsx"].map(file => [file, readFileSync(path.join("apps/web", file), "utf8")]),
)) {
  const budgets = typeof budgetsPathOrObj === "string" ? JSON.parse(readFileSync(budgetsPathOrObj, "utf8")) : budgetsPathOrObj;
  const manifest = JSON.parse(readFileSync(path.join(dist, ".vite/manifest.json"), "utf8"));
  const { initial } = checkInitialBudget(dist);
  const boundaries = new Map();
  for (const [file, code] of Object.entries(sources)) {
    // shortcut: direct entry imports only; extend this parser if an entry switches to a named loader.
    for (const [, loader, imported] of code.matchAll(/\b(bootScreen|screen)\(\s*\(\)\s*=>\s*import\(["']([^"']+)["']\)\s*\)/g)) {
      boundaries.set(path.posix.normalize(path.posix.join(path.posix.dirname(file), imported)) + ".tsx", loader);
    }
  }
  let maxKb = 0;
  let chunksCount = 0;
  const catalogs = Object.keys(manifest).filter(key => manifest[key].isDynamicEntry && /\/catalogs\/boot-[^/]+\.ts$/.test(key));
  if (!catalogs.length) throw new Error("check-bundle: missing boot catalog entries");
  for (const catalog of catalogs) {
    const files = new Set();
    const visit = key => {
      const entry = manifest[key];
      if (!entry) throw new Error(`check-bundle: missing sign-in critical chunk ${key}`);
      if (initial.has(entry.file) || files.has(entry.file)) return;
      files.add(entry.file);
      for (const imported of entry.imports ?? []) visit(imported);
    };
    visit("src/lib/react/session.ts");
    for (const source of ["src/auth/Login.tsx", "src/auth/SetupPasskey.tsx", "src/auth/IdleGuard.tsx"]) {
      const loader = boundaries.get(source);
      if (!loader) throw new Error(`check-bundle: missing catalog boundary for ${source}`);
      visit(source);
      visit(catalog);
      if (loader === "screen") visit(catalog.replace(/boot-([^/]+)\.ts$/, "$1.ts"));
    }
    const size = [...files].reduce((sum, file) => sum + kb(dist, file), 0);
    if (size > maxKb) { maxKb = size; chunksCount = files.size; }
  }
  const budgetKb = budgets.shell.budget_kb;
  return { ok: maxKb <= budgetKb, sizeKb: maxKb, chunksCount, budgetKb,
    error: maxKb > budgetKb ? `check-bundle: sign-in critical path is ${maxKb.toFixed(1)} KB gz, over the ${budgetKb} KB shell budget` : undefined };
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
  console.log(`CSS: first page ${initResult.cssKb.toFixed(1)} KB gz / budget ${INITIAL_CSS_BUDGET_KB} KB in ${initResult.sheets.size} stylesheet(s); heaviest route per page type:`);
  for (const [pt, stats] of Object.entries(routeResult.measured)) {
    console.log(`  ${pt.padEnd(8)} ${stats.maxCssKb.toFixed(1).padStart(5)} KB gz / budget ${stats.cssBudgetKb ?? "none"} KB (max: ${stats.cssChunk ?? "none"})`);
  }
  if (!routeResult.ok) {
    for (const fail of routeResult.failures) {
      console.error(fail.error);
    }
    process.exit(1);
  }

  const signIn = checkSignInBudget(dist, budgetFile);
  console.log(`sign-in critical path ${signIn.sizeKb.toFixed(1)} KB gz beyond entry / shell budget ${signIn.budgetKb} KB`);
  if (!signIn.ok) { console.error(signIn.error); process.exit(1); }

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
