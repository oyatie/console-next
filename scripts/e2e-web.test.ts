// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { alive, children, dir, eventually, freePort } from "./backend-process-fixture";

test.each(["complete", "SIGINT", "SIGTERM", "SIGKILL"] as const)("Vite stops when its Playwright lane ends: %s", async (reason) => {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const config = path.join(dir, `web-${reason}.config.mjs`);
  const spec = path.join(dir, `web-${reason}.spec.mjs`);
  const ready = path.join(dir, `web-${reason}.ready`);
  writeFileSync(config, `
    import config from ${JSON.stringify(path.resolve("playwright.config.ts"))};
    export default {
      testDir: ${JSON.stringify(dir)}, testMatch: ${JSON.stringify(path.basename(spec))}, workers: 1,
      webServer: {
        ...config.webServer[1], cwd: ${JSON.stringify(process.cwd())}, url: ${JSON.stringify(origin)},
        reuseExistingServer: false, timeout: 30_000,
        env: { ...config.webServer[1].env, CONSOLE_WEB_PORT: '${port}' },
      },
      use: { browserName: 'chromium', headless: true },
      outputDir: ${JSON.stringify(path.join(dir, `results-${reason}`))},
    };
  `);
  writeFileSync(spec, `
    import { test, expect } from ${JSON.stringify(path.resolve("node_modules/@playwright/test/index.mjs"))};
    import { writeFileSync } from 'node:fs';
    test('Vite responds in Chromium', async ({ page }) => {
      const response = await page.goto('${origin}');
      expect(response.ok()).toBe(true);
      await expect(page.locator('body')).toBeVisible();
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      ${reason === "complete" ? "" : "await page.waitForTimeout(60_000);"}
    });
  `);
  const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "-c", config], {
    env: { ...process.env, E2E_SERVED: "0", E2E_REUSE: "0" }, stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let group: number | undefined;
  try {
    await eventually(() => existsSync(ready) || child.exitCode !== null, Boolean);
    expect(existsSync(ready), output).toBe(true);
    if (reason !== "complete") {
      const listener = spawnSync("lsof", ["-w", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
      const pid = Number(listener.stdout.match(/^p(\d+)$/m)?.[1]);
      expect(pid, JSON.stringify({ ...listener, output })).toBeGreaterThan(1);
      group = Number(spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }).stdout.trim());
      child.kill(reason);
    }
    const result = await exited;
    if (reason === "complete") expect(result, output).toEqual({ code: 0, signal: null });
    await eventually(() => spawnSync("lsof", ["-w", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" }).stdout, value => value === "");
  } finally {
    // The fail-before run deliberately leaves Vite alive; clean only the group this test launched.
    if (group && group > 1) {
      try { process.kill(-group, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && alive(group)) throw error; }
    }
  }
}, 60_000);
