// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { checkRouteBudgets, checkInitialBudget, INITIAL_BUDGET_KB, DEFAULT_BUDGET_FILE } from "./check-bundle.mjs";

describe("check-bundle budgets (JRN-FIRSTPAINT / J-HP-4)", () => {
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

    // Helper to write chunk with a targeted content
    const writeChunk = (filename, content, imports = []) => {
      const importLines = imports.map((i) => `import "./${i}";`).join("\n");
      const code = `${importLines}\n${content}`;
      writeFileSync(path.join(assets, filename), code, "utf8");
    };

    return { dir, dist, assets, dynamic, manifest, writeChunk, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

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
      const budgets = { shell: { budget_kb: 50, routes: ["src/screen.tsx"] } };
      writeFileSync(file, JSON.stringify(budgets));
      checkRouteBudgets(mock.dist, file, { lower: true });
      assert.strictEqual(JSON.parse(readFileSync(file, "utf8")).shell.budget_kb, 1);
      budgets.shell.budget_kb = 0.001;
      writeFileSync(file, JSON.stringify(budgets));
      assert.strictEqual(checkRouteBudgets(mock.dist, file, { lower: true }).ok, false);
      assert.strictEqual(JSON.parse(readFileSync(file, "utf8")).shell.budget_kb, 0.001);
    } finally { mock.cleanup(); }
  });

  it("the initial budget check is unchanged", () => {
    const mock = createMockDist();
    try {
      // Small initial chunk set under INITIAL_BUDGET_KB (151 KB)
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
      assert.match(failResult.error, /initial load is.*over the 151.*budget/i);
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
      for (const file of ["index-main.js", "vendor-boot.js", "dryrun.js", "calendar.js", "answers.js"]) mock.writeChunk(file, file);
      const source = "src/features/import/ui/resolve-controls.tsx";
      const route = "src/features/import/ui/dryrun-step.tsx";
      mock.dynamic("src/ui/date/date-calendar.tsx", "calendar.js");
      mock.dynamic(source, "answers.js");
      mock.dynamic(route, "dryrun.js", [source]);
      assert.match(checkRouteBudgets(mock.dist, DEFAULT_BUDGET_FILE).error, /resolve-controls.*statically loaded/);
      mock.dynamic(route, "dryrun.js");
      assert.strictEqual(checkRouteBudgets(mock.dist, DEFAULT_BUDGET_FILE).ok, true);
    } finally { mock.cleanup(); }
  });

});
