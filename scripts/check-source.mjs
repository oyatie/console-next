#!/usr/bin/env node
// Source gate: the structure rules oxlint cannot express.
//   1. Imports: features never import other features; lib/ui/reference never import upward;
//      nothing imports routes/ (main.tsx excepted); packages never import apps.
//   2. Data layer: query keys are derived in lib/query.ts only (`queryKey`); no cache writes
//      (`setQueryData` / `setQueriesData`).
//   3. Placement: inside a slice only {api,present}.ts, api/*.ts, *.test.ts, domain/*.ts and ui/{*.tsx,use-*.ts,*.spec.ts,*.playwright.ts}.
//   4. Freshness loops (scripts/check-loops.mjs): no setInterval, refetchInterval or focus refetch.
//   5. Ratchet: every `max-lines` pin in oxlint.json equals the file's current count, so a shrink
//      forces the pin down in the same diff.
//   6. E2E tenants: every tenant slug literal in e2e/ is written once, so specs sharing one database never collide
//      (a second POST /api/platform/orgs of a slug is 409 slug_taken).
//   7. Versioned writes: a file that sends a request carrying `expected_updated_at` takes the version through
//      lib/record-versions (`pinned` / `versionToSend`), so a command read before this tab's own earlier write is not
//      refused against it (docs/design/concurrent-editing.md ME-6); a version read straight off the screen is refused.
//   8. Public tree: no tracked delivery directories or local machine paths; deliberate refusal fixtures need a reason.
// BASELINE holds today's known violations. It may only shrink: an entry that no longer matches fails
// too, so a fix deletes its entry in the same diff.
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOOP_ALLOW, loopProblems } from "./check-loops.mjs";

const APP = "apps/web/src";
const ROOTS = [APP, "packages/api/src", "packages/i18n/src"];
const GENERATED = new Set(["packages/api/src/schema.d.ts"]);

const BASELINE = {
  // Deliberate refusal fixtures only, using the same file -> reason convention as LOOP_ALLOW.
  localPaths: {
    "scripts/check-hermetic.test.mjs": "Plants host dependencies to prove npm check rejects machine-local inputs.",
    "scripts/check-source.test.ts": "Plants machine paths to prove the public-tree gate refuses them.",
    "scripts/client-data-scan.py": "Names the local-path prefixes it refuses in uploaded workbook links.",
  },
  // from -> to
  imports: [
  ],
  // file -> count of /\bqueryKey\b/ outside lib/query.ts
  queryKey: {},
  // file -> count of .setQueryData( / .setQueriesData(
  cacheWrites: {},
  // today's slice files, from before the slice layout
  placement: [
    "apps/web/src/features/account/Account.tsx",
    "apps/web/src/features/home/Home.tsx",
    "apps/web/src/features/org/OrgChange.tsx",
    "apps/web/src/features/people/Accounts.tsx",
    "apps/web/src/features/people/ExitCase.tsx",
    "apps/web/src/features/people/People.tsx",
    "apps/web/src/features/platform/Tenants.tsx",
  ],
};

const posix = (p) => p.split(path.sep).join("/");
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mjs|css)$/.test(name) && !GENERATED.has(posix(p))) files.push(posix(p));
  }
};
ROOTS.forEach(walk);

const problems = [];
const seen = { imports: new Set(), queryKey: {}, cacheWrites: {}, placement: new Set(), loops: new Set() };

// A relative product path such as features/home/ui is not an absolute home directory.
const LOCAL_PATH = /(?<![\w.-])(?:\/(?:Users\/[^/\s"'`<>\\]+\/|home\/(?!runner\/)[^/\s"'`<>\\]+\/|private\/tmp\/)|[Cc]:\\+Users\\+)/;
const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (tracked.status !== 0) throw new Error(`cannot enumerate tracked files: ${tracked.stderr}`);
const localPaths = new Set();
for (const f of tracked.stdout.split("\0").filter(Boolean)) {
  if (/^(?:relay|lanes|docs\/lanes)\//.test(f))
    problems.push(`${f}: delivery evidence belongs outside the product repository`);
  if (!existsSync(f) || !statSync(f).isFile()) continue;
  const bytes = readFileSync(f);
  if (bytes.includes(0)) continue;
  bytes.toString("utf8").split("\n").forEach((line, i) => {
    if (!LOCAL_PATH.test(line)) return;
    localPaths.add(f);
    if (!BASELINE.localPaths[f]?.trim()) problems.push(`${f}:${i + 1}: local machine path; keep delivery evidence outside the product repository`);
  });
}
for (const f of Object.keys(BASELINE.localPaths)) if (!localPaths.has(f)) problems.push(`stale baseline local-path fixture (delete it): ${f}`);

// Zone of a file: "features/<slice>", "reference/<slice>", "lib", "ui", "routes", ..., or "packages".
const zone = (f) => {
  if (f.startsWith("packages/")) return "packages";
  if (!f.startsWith(APP + "/")) return "other";
  const [top, slice] = f.slice(APP.length + 1).split("/");
  return top === "features" || top === "reference" ? `${top}/${slice}` : top;
};
const resolve = (from, spec) => {
  const base = posix(path.normalize(path.join(path.dirname(from), spec)));
  const hit = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((x) => base + x).find((c) => existsSync(c) && statSync(c).isFile());
  return hit ?? base;
};
const LOWER = new Set(["lib", "ui"]);
const UPPER = (z) => /^(features|routes|shell|auth|gallery)\b/.test(z) || z === "main.tsx";
const importRule = (from, to) => {
  const a = zone(from), b = zone(to);
  if (a === "packages" && to.startsWith("apps/")) return "packages never import apps";
  if (b === "routes" && a !== "routes" && a !== "main.tsx" && !to.endsWith("route-tree.gen.ts")) return "nothing imports routes/";
  if (a.startsWith("features/") && b.startsWith("features/") && a !== b) return "features never import other features";
  if ((LOWER.has(a) || a.startsWith("reference/")) && UPPER(b)) return `${a} never imports upward`;
  return undefined;
};

const SLICE_FILE = /^(?:(?:api|present)\.ts|api\/[a-z0-9-]+\.ts|[a-z0-9-]+\.test\.ts|domain\/[a-z0-9/-]+(?:\.test)?\.ts|ui\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.tsx|use-[a-z0-9-]+\.ts|[a-z0-9-]+(?:\.gallery)?\.module\.css|[a-z0-9-]+\.(?:test\.tsx?|spec\.ts|playwright\.ts)))$/;

const count = (src, re) => src.match(re)?.length ?? 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const [, spec] of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
    if (!spec.startsWith(".")) continue;
    const to = resolve(f, spec);
    const why = importRule(f, to);
    if (!why) continue;
    const key = `${f} -> ${to}`;
    seen.imports.add(key);
    if (!BASELINE.imports.includes(key)) problems.push(`${key}: ${why}`);
  }
  // Dev gallery fixtures may seed API-derived cache entries; production screens only invalidate.
  const fixture = f.endsWith(".gallery.tsx");
  const keys = fixture || f === `${APP}/lib/query.ts` ? 0 : count(src, /\bqueryKey\b/g);
  if (keys) seen.queryKey[f] = keys;
  const writes = fixture ? 0 : count(src, /\.set(?:Query|Queries)Data\(/g);
  if (writes) seen.cacheWrites[f] = writes;
  const loops = loopProblems(f, src);
  if (loops.length) seen.loops.add(f);
  if (!Object.hasOwn(LOOP_ALLOW, f)) problems.push(...loops);
  if (f.startsWith(`${APP}/`) && !/\.test\.tsx?$/.test(f) && /\bapi\.(?:POST|PUT|PATCH|DELETE)\(/.test(src) && /\bexpected_updated_at\b/.test(src) && !/lib\/record-versions["']/.test(src))
    problems.push(`${f}: sends expected_updated_at without lib/record-versions (pinned / versionToSend)`);
  const z = zone(f);
  if (/^(features|reference)\//.test(z)) {
    const inSlice = f.slice(APP.length + 1 + z.length + 1);
    if (!SLICE_FILE.test(inSlice)) {
      seen.placement.add(f);
      if (!BASELINE.placement.includes(f)) problems.push(`${f}: a slice holds only {api,present}.ts, api/*.ts, *.test.ts, domain/*.ts and ui/{kebab}.tsx|use-*.ts`);
    }
  }
}

for (const [kind, why] of [["queryKey", "query keys are derived in lib/query.ts"], ["cacheWrites", "no cache writes; commands invalidate"]]) {
  for (const f of new Set([...Object.keys(seen[kind]), ...Object.keys(BASELINE[kind])])) {
    const now = seen[kind][f] ?? 0, pin = BASELINE[kind][f] ?? 0;
    if (now !== pin) problems.push(`${f}: ${kind} ×${now}, baseline ×${pin} (${now > pin ? why : "lower the baseline"})`);
  }
}
for (const key of BASELINE.imports) if (!seen.imports.has(key)) problems.push(`stale baseline import (delete it): ${key}`);
for (const f of Object.keys(LOOP_ALLOW)) if (!seen.loops.has(f)) problems.push(`stale loop allow-list entry (delete it): ${f}`);
for (const f of BASELINE.placement) if (!seen.placement.has(f)) problems.push(`stale baseline placement (delete it): ${f}`);

// max-lines pins: each literal path pinned in oxlint.json must sit at exactly its current count.
const pins = new Map();
for (const o of JSON.parse(readFileSync("oxlint.json", "utf8")).overrides ?? []) {
  const rule = o.rules?.["max-lines"];
  if (!Array.isArray(rule)) continue;
  for (const f of o.files) if (!/[*?[{]/.test(f)) pins.set(f, rule[1].max);
}
if (pins.size) {
  const missing = [...pins.keys()].filter((f) => !existsSync(f));
  missing.forEach((f) => problems.push(`${f}: max-lines pin for a missing file (move or delete the pin)`));
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), "check-source-")), "count.json");
  writeFileSync(cfg, JSON.stringify({ plugins: [], categories: { correctness: "off" }, rules: { "max-lines": ["error", { max: 1, skipBlankLines: true, skipComments: true }] } }));
  const present = [...pins.keys()].filter((f) => existsSync(f));
  const out = spawnSync("node_modules/.bin/oxlint", ["-c", cfg, "-f", "unix", ...present], { encoding: "utf8" }).stdout;
  const counts = new Map([...out.matchAll(/^(.+?):\d+:\d+: File has too many lines \((\d+)\)/gm)].map(([, f, n]) => [posix(f), Number(n)]));
  for (const f of present) {
    const n = counts.get(f) ?? 1;
    if (n !== pins.get(f)) problems.push(`${f}: max-lines pin ${pins.get(f)} but the file counts ${n}; set the pin to ${n}${n <= 300 ? " (or delete it)" : ""}`);
  }
}

// E2E tenant slugs: `unique("x")`, a helper's slug among its first two arguments after `browser` (openTenant,
// tenantInSetup, world(browser, 2, "x"), …) and a `slug = "x"` default. Korean names never match the slug pattern.
// literal-only; a slug built at runtime is not seen.
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const slugSites = new Map();
const e2e = [];
const walkE2e = (dir) => readdirSync(dir).forEach((n) => (statSync(path.join(dir, n)).isDirectory() ? walkE2e(path.join(dir, n)) : /\.ts$/.test(n) && e2e.push(posix(path.join(dir, n)))));
walkE2e("e2e");
for (const f of e2e) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const found = [
      ...[...line.matchAll(/\bunique\("([^"]+)"\)|\bslug = "([^"]+)"/g)].map((m) => m[1] ?? m[2]),
      ...[...line.matchAll(/\b\w+\(browser,([^)]*)\)/g)].flatMap((m) => m[1].split(",").slice(0, 2).map((a) => a.trim().match(/^"([^"]+)"$/)?.[1] ?? "")),
    ];
    for (const slug of found.filter((x) => SLUG.test(x))) slugSites.set(slug, [...(slugSites.get(slug) ?? []), `${f}:${i + 1}`]);
  });
}
for (const [slug, sites] of slugSites) if (sites.length > 1) problems.push(`e2e tenant slug "${slug}" is written at ${sites.join(", ")}: give each its own slug (one database, one slug)`);

if (problems.length) {
  console.error(`source: ${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
