// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { checkRouteBudgets as checkRoutes, checkSignInBudget, checkInitialBudget, INITIAL_BUDGET_KB, DEFAULT_BUDGET_FILE } from "./check-bundle.mjs";

describe("check-bundle budgets (JRN-FIRSTPAINT / J-HP-4)", () => {
  const lists = ["src/routes/org-tabs.tsx", "src/features/org/ui/org-changes.tsx", "src/features/org-bulk/ui/history-page.tsx"];
  const record = "src/features/org/OrgChange.tsx";
  const orgBudgets = { org: { budget_kb: 300, routes: [...lists, record] } };
  const checkRouteBudgets = (dist, budgets, options) => checkRoutes(dist,
    typeof budgets === "string" ? budgets : { ...budgets, ...orgBudgets }, options);
  const createMockDist = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-test-"));
    const dist = path.join(dir, "dist");
    const assets = path.join(dist, "assets");
    mkdirSync(assets, { recursive: true });

    // Minimal index.html
    const indexHtml = `<!DOCTYPE html><html><head>
      <script type="module" src="/assets/index-main.js"></script>
      <link rel="modulepreload" href="/assets/vendor-boot.js">
    </head><body></body></html>`;
    writeFileSync(path.join(dist, "index.html"), indexHtml, "utf8");

    mkdirSync(path.join(dist, ".vite"));
    const manifest = {};
    const dynamic = (source, file, imports = []) => {
      manifest[source] = { file: `assets/${file}`, isDynamicEntry: true, imports };
      writeFileSync(path.join(dist, ".vite/manifest.json"), JSON.stringify(manifest));
    };

    for (const [index, source] of [...lists, record].entries()) {
      const file = `org-${index}.js`;
      writeFileSync(path.join(assets, file), "screen");
      dynamic(source, file);
    }

    manifest[lists[0]].dynamicImports = [record];
    writeFileSync(path.join(dist, ".vite/manifest.json"), JSON.stringify(manifest));

    // Helper to write chunk with a targeted content
    const writeChunk = (filename, content, imports = []) => {
      const importLines = imports.map((i) => `import "./${i}";`).join("\n");
      const code = `${importLines}\n${content}`;
      writeFileSync(path.join(assets, filename), code, "utf8");
    };

    return { dir, dist, assets, dynamic, manifest, writeChunk, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it("sign-in counts only the locale catalogs its loaders await, including shared imports once", () => {
    const mock = createMockDist();
    try {
      for (const file of ["index-main.js", "vendor-boot.js", "login.js", "setup.js", "idle.js", "session.js", "shared.js", "boot-ko.js", "boot-en.js"]) mock.writeChunk(file, file);
      for (const locale of ["ko", "en"]) mock.writeChunk(`${locale}.js`, randomBytes(100_000).toString("hex"));
      mock.dynamic("src/auth/Login.tsx", "login.js", ["_shared"]);
      mock.dynamic("src/auth/IdleGuard.tsx", "idle.js", ["_shared"]);
      mock.dynamic("src/auth/SetupPasskey.tsx", "setup.js", ["_shared"]);
      mock.dynamic("src/lib/react/session.ts", "session.js");
      mock.manifest._shared = { file: "assets/shared.js" };
      for (const locale of ["ko", "en"]) {
        mock.dynamic(`../../packages/i18n/src/catalogs/boot-${locale}.ts`, `boot-${locale}.js`, ["_shared"]);
        mock.dynamic(`../../packages/i18n/src/catalogs/${locale}.ts`, `${locale}.js`);
      }
      const sources = {
        "src/routes/app.ts": 'component: lazyRouteComponent(bootScreen(() => import("../auth/Login")), "Login"); lazyRouteComponent(bootScreen(() => import("../auth/SetupPasskey")), "SetupPasskey")',
        "src/main.tsx": 'const IdleGuard = lazy(() => bootScreen(() => import("./auth/IdleGuard"))())',
      };
      const budgets = { shell: { budget_kb: 10 } };
      const result = checkSignInBudget(mock.dist, budgets, sources);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.chunksCount, 6);
      for (const file of Object.keys(sources)) {
        const changed = { ...sources, [file]: sources[file].replace("bootScreen(", "screen(") };
        const failure = checkSignInBudget(mock.dist, budgets, changed);
        assert.strictEqual(failure.ok, false);
        assert.match(failure.error, /sign-in critical path.*over the 10/);
      }
      assert.throws(() => checkSignInBudget(mock.dist, budgets, { ...sources, "src/routes/app.ts": "unrecognized loader" }), /missing catalog boundary/);
      delete mock.manifest["../../packages/i18n/src/catalogs/ko.ts"];
      writeFileSync(path.join(mock.dist, ".vite/manifest.json"), JSON.stringify(mock.manifest));
      assert.throws(() => checkSignInBudget(mock.dist, budgets, { ...sources, "src/routes/app.ts": sources["src/routes/app.ts"].replace("bootScreen(", "screen(") }), /missing.*catalogs\/ko/);
      for (const key of Object.keys(mock.manifest)) if (key.includes("/catalogs/boot-")) delete mock.manifest[key];
      writeFileSync(path.join(mock.dist, ".vite/manifest.json"), JSON.stringify(mock.manifest));
      assert.throws(() => checkSignInBudget(mock.dist, budgets, sources), /missing boot catalog entries/);
    } finally { mock.cleanup(); }
  });

  it("a planted route chunk set over its page-type budget fails with the route and size", () => {
    const mock = createMockDist();
    try {
      // Entry and initial vendor
      mock.writeChunk("index-main.js", "console.log('main');");
      mock.writeChunk("vendor-boot.js", "console.log('vendor');");

      // Plant a 'list' route chunk set (e.g. tenants list) that exceeds a 20 KB budget
      // Random bytes ensure ~25 KB gzip
      const randomData = randomBytes(25000).toString("hex");
      mock.writeChunk("Tenants-list.js", `export const data = "${randomData}";`, ["tenants-sub.js"]);
      mock.writeChunk("tenants-sub.js", "export const y = 42;");

      const budgets = {
        list: { budget_kb: 20, routes: ["src/features/platform/Tenants.tsx"] },
      };

      mock.dynamic("src/features/platform/Tenants.tsx", "Tenants-list.js", ["_sub"]);
      mock.manifest._sub = { file: "assets/tenants-sub.js" };
      writeFileSync(path.join(mock.dist, ".vite/manifest.json"), JSON.stringify(mock.manifest));
      const result = checkRouteBudgets(mock.dist, budgets);
      assert.strictEqual(result.ok, false, "expected check to fail for over-budget route");
      assert.strictEqual(result.route, "src/features/platform/Tenants.tsx");
      assert.ok(result.sizeKb > 20, `expected sizeKb (${result.sizeKb}) to be > 20`);
      assert.match(result.error, /Tenants/);
      assert.match(result.error, /over the 20.*budget/i);
    } finally {
      mock.cleanup();
    }
  });

  it("a set under its page-type budget passes", () => {
    const mock = createMockDist();
    try {
      mock.writeChunk("index-main.js", "console.log('main');");
      mock.writeChunk("vendor-boot.js", "console.log('vendor');");

      // Small list route chunk set under 50 KB budget
      mock.writeChunk("Tenants-list.js", "console.log('tenants');", ["tenants-sub.js"]);
      mock.writeChunk("tenants-sub.js", "console.log('tenants sub');");

      const budgets = {
        list: { budget_kb: 50, routes: ["src/features/platform/Tenants.tsx"] },
      };

      mock.dynamic("src/features/platform/Tenants.tsx", "Tenants-list.js", ["_sub"]);
      mock.manifest._sub = { file: "assets/tenants-sub.js" };
      writeFileSync(path.join(mock.dist, ".vite/manifest.json"), JSON.stringify(mock.manifest));
      const result = checkRouteBudgets(mock.dist, budgets);
      assert.strictEqual(result.ok, true, "expected check to pass for under-budget route");
      assert.strictEqual(result.failures.length, 0);
    } finally {
      mock.cleanup();
    }
  });

  it("an unclassified dynamic source fails even when its filename or hash resembles another page type", () => {
    const mock = createMockDist();
    try {
      mock.writeChunk("index-main.js", "main");
      mock.writeChunk("vendor-boot.js", "vendor");
      mock.writeChunk("Tenants-list-orgshell.js", "screen");
      mock.dynamic("src/features/new/unknown.tsx", "Tenants-list-orgshell.js");
      const result = checkRouteBudgets(mock.dist, { list: { budget_kb: 50, routes: ["src/features/platform/Tenants.tsx"] } });
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /unclassified.*src\/features\/new\/unknown/);
    } finally { mock.cleanup(); }
  });

  it("--lower only reduces budgets and never raises them", () => {
    const mock = createMockDist();
    try {
      mock.writeChunk("index-main.js", "main");
      mock.writeChunk("vendor-boot.js", "vendor");
      mock.writeChunk("screen.js", "screen");
      mock.dynamic("src/screen.tsx", "screen.js");
      const file = path.join(mock.dir, "budget.json");
      const budgets = { ...orgBudgets, shell: { budget_kb: 50, routes: ["src/screen.tsx"] } };
      writeFileSync(file, JSON.stringify(budgets));
      checkRouteBudgets(mock.dist, file, { lower: true });
      assert.strictEqual(JSON.parse(readFileSync(file, "utf8")).shell.budget_kb, 1);
      budgets.shell.budget_kb = 0.001;
      writeFileSync(file, JSON.stringify(budgets));
      assert.strictEqual(checkRouteBudgets(mock.dist, file, { lower: true }).ok, false);
      assert.strictEqual(JSON.parse(readFileSync(file, "utf8")).shell.budget_kb, 0.001);
    } finally { mock.cleanup(); }
  });

  it("rejects an initial load 0.1 KB over the ratcheted budget", () => {
    const mock = createMockDist();
    try {
      const budgetKb = INITIAL_BUDGET_KB;
      assert.ok(budgetKb <= 149, "the 147 KB target permits at most 2 KB headroom");
      const targetBytes = Math.round((budgetKb + 0.1) * 1024);
      // Deterministic incompressible bytes keep the fixture within one byte of the boundary.
      const data = createHash("shake256", { outputLength: targetBytes }).update("initial bundle boundary").digest();
      mock.writeChunk("vendor-boot.js", "vendor");
      const vendorBytes = gzipSync(readFileSync(path.join(mock.assets, "vendor-boot.js"))).length;
      const length = targetBytes - vendorBytes - (gzipSync(data).length - data.length);
      writeFileSync(path.join(mock.assets, "index-main.js"), data.subarray(0, length));
      const result = checkInitialBudget(mock.dist);
      assert.strictEqual(result.sizeKb.toFixed(1), (budgetKb + 0.1).toFixed(1));
      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes(`over the ${budgetKb} KB budget`));
    } finally { mock.cleanup(); }
  });

  it("normalisation preserves the clean dev build's raw-budget headroom", () => {
    const rawKb = 148.6640625;
    const normalisedKb = 145.0751953125;
    const equivalentBudgetKb = 148.8 - (rawKb - normalisedKb);
    assert.strictEqual(INITIAL_BUDGET_KB, Math.floor(equivalentBudgetKb * 1000) / 1000);
    assert.ok(INITIAL_BUDGET_KB >= normalisedKb);
  });

  it("initial gzip size ignores hash-only changes in entry and preloaded assets", () => {
    const mock = createMockDist();
    try {
      const sizes = [];
      for (const hashes of [["Abcd12_-", "Efgh5678", "Ijkl9012"], ["aaaaaaaa", "aaaaaaaa", "aaaaaaaa"]]) {
        mock.writeChunk("index-main.js", `import "./vendor-${hashes[0]}.js"; const deps = ["assets/list-${hashes[1]}.js", "assets/list-${hashes[1]}.css"];`);
        mock.writeChunk("vendor-boot.js", `export const deps = ["assets/record-${hashes[2]}.js"];`);
        sizes.push(checkInitialBudget(mock.dist).sizeKb);
      }
      assert.strictEqual(sizes[0], sizes[1]);
      mock.writeChunk("vendor-boot.js", "export const more = 'actual code growth';");
      assert.notStrictEqual(checkInitialBudget(mock.dist).sizeKb, sizes[0]);
    } finally { mock.cleanup(); }
  });

  it("normalised fixture size equals raw gzip size minus only the hash overhead", () => {
    const mock = createMockDist();
    try {
      mock.writeChunk("index-main.js", 'import "./vendor-Abcd12_-.js"; const deps = ["assets/list-Efgh5678.js", "assets/list-Efgh5678.css"];');
      mock.writeChunk("vendor-boot.js", 'export const deps = ["assets/record-Ijkl9012.js"];');
      const rawBytes = ["index-main.js", "vendor-boot.js"].reduce((sum, file) =>
        sum + gzipSync(readFileSync(path.join(mock.assets, file))).length, 0);
      assert.strictEqual(rawBytes, 170);
      // These fixed hashes contribute 15 gzip bytes over the same fixture with HASHHASH.
      assert.strictEqual(checkInitialBudget(mock.dist).sizeKb, (rawBytes - 15) / 1024);
    } finally { mock.cleanup(); }
  });

  it("the initial budget check includes preloaded chunks", () => {
    const mock = createMockDist();
    try {
      // Small initial chunk set under INITIAL_BUDGET_KB
      mock.writeChunk("index-main.js", "console.log('main');");
      mock.writeChunk("vendor-boot.js", "console.log('vendor');");

      const okResult = checkInitialBudget(mock.dist, INITIAL_BUDGET_KB);
      assert.strictEqual(okResult.ok, true);
      assert.ok(okResult.sizeKb <= INITIAL_BUDGET_KB);

      // Plant huge initial chunk that exceeds INITIAL_BUDGET_KB (160 KB random data)
      const hugeRandom = randomBytes(160000).toString("hex");
      mock.writeChunk("vendor-boot.js", `export const huge = "${hugeRandom}";`);

      const failResult = checkInitialBudget(mock.dist, INITIAL_BUDGET_KB);
      assert.strictEqual(failResult.ok, false);
      assert.ok(failResult.sizeKb > INITIAL_BUDGET_KB);
      assert.match(failResult.error, new RegExp(`initial load is.*over the ${INITIAL_BUDGET_KB}.*budget`, "i"));
    } finally {
      mock.cleanup();
    }
  });

  it("wizard interactions must be split out of both route and initial chunk sets", () => {
    const mock = createMockDist();
    try {
      mock.writeChunk("index-main.js", "main");
      mock.writeChunk("vendor-boot.js", "vendor");
      mock.writeChunk("wizard.js", "wizard");
      mock.writeChunk("calendar.js", "calendar");
      const source = "src/ui/date/date-calendar.tsx";
      const route = "src/features/people/ui/register-route.tsx";
      const budgets = { wizard: { budget_kb: 167, routes: [route], deferred: [source] } };
      mock.dynamic(route, "wizard.js", [source]);
      mock.dynamic(source, "calendar.js");
      assert.match(checkRouteBudgets(mock.dist, budgets).error, /date-calendar.*statically loaded/);
      mock.dynamic(route, "wizard.js");
      mock.manifest[route].dynamicImports = [source];
      writeFileSync(path.join(mock.dist, ".vite/manifest.json"), JSON.stringify(mock.manifest));
      assert.strictEqual(checkRouteBudgets(mock.dist, budgets).ok, true);
      mock.dynamic(source, "vendor-boot.js");
      assert.match(checkRouteBudgets(mock.dist, budgets).error, /date-calendar.*statically loaded/);
    } finally { mock.cleanup(); }
  });

  it("a missing interaction entry cannot silently bypass the split guard", () => {
    const mock = createMockDist();
    try {
      mock.writeChunk("index-main.js", "main");
      mock.writeChunk("vendor-boot.js", "vendor");
      mock.writeChunk("wizard.js", "wizard");
      const route = "src/features/people/ui/register-route.tsx";
      mock.dynamic(route, "wizard.js");
      const result = checkRouteBudgets(mock.dist, { wizard: { budget_kb: 167, routes: [route], deferred: ["src/ui/date/date-calendar.tsx"] } });
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /date-calendar.*dynamic entry/);
    } finally { mock.cleanup(); }
  });
  it("keeps conditional import answers out of wizard first paint", () => {
    const mock = createMockDist();
    try {
      for (const file of ["index-main.js", "vendor-boot.js", "dryrun.js", "calendar.js", "answers.js", "host.js"]) mock.writeChunk(file, file);
      const source = "src/features/import/ui/resolve-controls.tsx";
      const route = "src/features/import/ui/dryrun-step.tsx";
      const deferred = Object.values(JSON.parse(readFileSync(DEFAULT_BUDGET_FILE, "utf8"))).flatMap(config => config.deferred ?? []);
      for (const [index, path] of deferred.entries()) {
        const file = `deferred-${index}.js`;
        mock.writeChunk(file, file);
        mock.dynamic(path, file);
      }
      mock.dynamic(route, "dryrun.js", [source]);
      assert.match(checkRouteBudgets(mock.dist, DEFAULT_BUDGET_FILE).error, /resolve-controls.*statically loaded/);
      mock.dynamic(route, "dryrun.js");
      assert.strictEqual(checkRouteBudgets(mock.dist, DEFAULT_BUDGET_FILE).ok, true);
    } finally { mock.cleanup(); }
  });

  for (const route of ["src/routes/org-tabs.tsx", "src/features/org/ui/org-changes.tsx", "src/features/org-bulk/ui/history-page.tsx"]) {
    it(`keeps record forms out of ${route}, including transitive re-exports`, () => {
      const mock = createMockDist();
      try {
        for (const file of ["index-main.js", "vendor-boot.js", "list.js", "barrel.js", "record.js", "consequence.js"]) mock.writeChunk(file, file);
        const record = "src/features/org/OrgChange.tsx";
        const budgets = { list: { budget_kb: 300, routes: [route] }, record: { budget_kb: 171, routes: [record] } };
        mock.dynamic(route, "list.js");
        mock.dynamic(record, "record.js");
        assert.strictEqual(checkRouteBudgets(mock.dist, budgets).ok, true);
        for (const target of [record, "_consequence"]) {
          mock.manifest._consequence = { file: "assets/consequence.js", name: "effectuate-consequence" };
          mock.manifest._barrel = { file: "assets/barrel.js", imports: [target] };
          mock.dynamic(route, "list.js", ["_barrel"]);
          assert.match(checkRouteBudgets(mock.dist, budgets).error, /statically loaded/);
        }
        mock.dynamic(route, "list.js");
        mock.dynamic(record, "list.js");
        assert.match(checkRouteBudgets(mock.dist, budgets).error, /statically loaded/);
        mock.dynamic(record, "vendor-boot.js");
        assert.match(checkRouteBudgets(mock.dist, budgets).error, /statically loaded/);
        delete mock.manifest[record];
        mock.dynamic(route, "list.js");
        assert.match(checkRouteBudgets(mock.dist, budgets).error, /OrgChange.*dynamic entry/);
      } finally { mock.cleanup(); }
    });
  }

  it("rejects a list hidden in the dynamically imported record barrel", () => {
    const mock = createMockDist();
    try {
      mock.writeChunk("index-main.js", "main");
      mock.writeChunk("vendor-boot.js", "vendor");
      delete mock.manifest[lists[1]];
      mock.manifest[lists[0]].dynamicImports = [record];
      writeFileSync(path.join(mock.dist, ".vite/manifest.json"), JSON.stringify(mock.manifest));
      const result = checkRouteBudgets(mock.dist, orgBudgets);
      assert.strictEqual(result.ok, false);
      assert.ok(result.failures.some(({ error }) => error.includes(`${lists[1]} must have its own dynamic entry`)));
    } finally { mock.cleanup(); }
  });

  for (const source of lists.slice(1)) {
    it(`rejects a dynamic record import from ${source}`, () => {
      const mock = createMockDist();
      try {
        mock.writeChunk("index-main.js", "main");
        mock.writeChunk("vendor-boot.js", "vendor");
        mock.manifest[source].dynamicImports = [record];
        writeFileSync(path.join(mock.dist, ".vite/manifest.json"), JSON.stringify(mock.manifest));
        assert.match(checkRouteBudgets(mock.dist, orgBudgets).error, /dynamically imports.*OrgChange/);
      } finally { mock.cleanup(); }
    });
  }

});
