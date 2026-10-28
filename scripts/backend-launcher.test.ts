// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { alive, children, dir, env, eventually, freePort, launchBackend, listener, plant, record, responds, type Listener } from "./backend-process-fixture";

test("Playwright starts the launcher even when a recorded orphan answers readyz", async () => {
  const orphan = await plant({ orphan: true });
  const config = path.join(dir, "playwright.config.mjs");
  const spec = path.join(dir, "orphan.spec.mjs");
  writeFileSync(config, `
    import config from ${JSON.stringify(path.resolve("playwright.config.ts"))};
    export default {
      testDir: ${JSON.stringify(dir)}, testMatch: 'orphan.spec.mjs', workers: 1,
      webServer: {
        ...config.webServer[0], cwd: ${JSON.stringify(process.cwd())}, timeout: 30_000,
        env: { ...config.webServer[0].env, E2E_CACHE_DIR: ${JSON.stringify(orphan.cache)} },
      },
      use: { browserName: 'chromium', headless: true },
      outputDir: ${JSON.stringify(path.join(dir, "results"))},
    };
  `);
  writeFileSync(spec, `
    import { test, expect } from ${JSON.stringify(path.resolve("node_modules/@playwright/test/index.mjs"))};
    test('reclaimed backend responds in Chromium', async ({ page }) => {
      await page.goto('http://127.0.0.1:${orphan.port}/readyz');
      expect(JSON.parse(await page.locator('body').innerText()).pid).not.toBe(${orphan.pid});
    });
  `);
  const file = record();
  const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "-c", config], {
    env: { ...env(file, orphan.port), E2E_CACHE_DIR: orphan.cache, E2E_REUSE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  expect(code, output).toBe(0);
  expect(alive(orphan.pid)).toBe(false);
  const next = await listener(file);
  await eventually(() => [alive(next.pid), alive(next.child)], (values) => values.every((value) => !value));
}, 45_000);

test.each(["0", "1"])("SIGUSR2 restarts only this launcher's group on the same port (child ignores TERM: %s)", async childIgnoresTerm => {
  const port = await freePort();
  const cache = mkdtempSync(path.join(dir, "publication-"));
  const run = launchBackend(port, { RECORD_WRITE_PROBE: "1", E2E_CACHE_DIR: cache, CHILD_IGNORE_TERM: childIgnoresTerm });
  const first = await listener(run.file);
  await eventually(run.output, (output) => output.includes("record-while-open:"));
  expect(run.output()).toContain("record-while-open: null");
  const previous = readFileSync(path.join(cache, "backend.json"), "utf8");
  run.child.kill("SIGUSR2");
  await eventually(() => [alive(first.pid), alive(first.child)], (values) => values.every((value) => !value));
  expect(run.child.exitCode).toBeNull();
  run.child.kill("SIGUSR2");
  await eventually(() => JSON.parse(readFileSync(run.file, "utf8")) as Listener, (value) => value.pid !== first.pid);
  const second = await listener(run.file);
  await eventually(run.output, (output) => output.includes(`record-while-open: ${JSON.stringify(previous)}`));
  expect(await responds(port)).toEqual({ pid: second.pid });
});

test("the next start removes abandoned record publications and preserves unrelated files", async () => {
  const cache = mkdtempSync(path.join(dir, "abandoned-"));
  const abandoned = ["backend.json.123.tmp", "backend.json.456.tmp"];
  const unrelated = ["backend.json.backup.tmp", "backend.json.tmp", "other.json.123.tmp"];
  for (const name of [...abandoned, ...unrelated]) writeFileSync(path.join(cache, name), "{");
  const run = launchBackend(await freePort(), { E2E_CACHE_DIR: cache });
  const api = await listener(run.file);
  expect(JSON.parse(readFileSync(path.join(cache, "backend.json"), "utf8"))).toMatchObject({ pid: run.child.pid, apiPid: api.pid });
  for (const name of abandoned) expect(existsSync(path.join(cache, name)), name).toBe(false);
  for (const name of unrelated) expect(readFileSync(path.join(cache, name), "utf8"), name).toBe("{");
});

test.each(["SIGINT", "SIGTERM", "exit", "stdin"] as const)("the backend process group is stopped on launcher %s", async (reason) => {
  const port = await freePort();
  const run = launchBackend(port);
  const api = await listener(run.file);
  const pgid = Number(spawnSync("ps", ["-p", String(api.pid), "-o", "pgid="], { encoding: "utf8" }).stdout.trim());
  expect(pgid).toBe(api.pid);
  if (reason === "exit") await fetch(`http://127.0.0.1:${port}/exit`);
  else if (reason === "stdin") run.child.stdin.end();
  else run.child.kill(reason);
  expect(await run.exited).toBe(reason === "exit" ? 7 : reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : 1);
  await eventually(() => [alive(api.pid), alive(api.child)], (values) => values.every((value) => !value));
});
