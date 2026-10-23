// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

function check(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "browser-setup-"));
  try {
    const file = join(dir, "planted.test.ts");
    writeFileSync(file, source);
    return spawnSync(process.execPath, [resolve("scripts/check-browser-test-setup.mjs"), file], { encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("browser startup belongs to beforeAll with its own timeout", () => {
  const result = check(`import { beforeAll } from 'vitest';
    beforeAll(async () => { await createServer(); await chromium.launch(); await browser.newPage(); }, 60000);`);
  expect(result.status, result.stderr).toBe(0);
});

test.each([
  `test('cold launch', async () => { await chromium.launch(); });`,
  `it.each([1])('cold page', async () => { await browser.newPage(); });`,
  `import { test as scenario } from 'vitest'; scenario('cold launch', async () => { await chromium.launch(); });`,
  `async function setup() { await chromium.launch(); } test('helper launch', setup);`,
  `beforeEach(async () => { await context.newPage(); }, 60000);`,
  `beforeAll(async () => { await chromium.launch(); });`,
  `const browser = await chromium.launch();`,
  `export function harness() { beforeEach(async () => { await browser.newPage(); }); }`,
])("refuses startup outside a timed beforeAll: %s", (source) => {
  const result = check(source);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("browser startup must run in beforeAll with an explicit hook timeout");
});

test("an aliased timed hook and its local helper pass; comments and strings are inert", () => {
  const result = check(`import { beforeAll as setup } from 'vitest';
    async function launch() { await chromium.launch(); }
    setup(launch, 60000);
    test('text', () => { const text = 'chromium.launch()'; /* browser.newPage() */ });`);
  expect(result.status, result.stderr).toBe(0);
});

test("exported harnesses register timed setup hooks", () => {
  const result = check(`export function harness() {
    beforeAll(async () => { await chromium.launch(); await browser.newPage(); }, 60000);
  }`);
  expect(result.status, result.stderr).toBe(0);
});

test("all browser-backed Vitest suites keep startup outside the test budget", () => {
  const result = spawnSync(process.execPath, ["scripts/check-browser-test-setup.mjs"], { encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
