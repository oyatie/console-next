// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { expect, test } from "vitest";
import { children, dir, freePort } from "./backend-process-fixture";

function liveGroup(group: number) {
  const result = spawnSync("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split("\n").filter(line => {
    const [, pgid, state] = line.trim().split(/\s+/);
    // Linux PID 1 can leave killed descendants as zombies; they cannot hold a port.
    return Number(pgid) === group && !state.startsWith("Z");
  });
}

test.each(["complete", "SIGINT", "SIGTERM", "SIGKILL"] as const)("Vite stops when its Playwright lane ends: %s", async (reason) => {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const config = path.join(dir, `web-${reason}.config.mjs`);
  const spec = path.join(dir, `web-${reason}.spec.mjs`);
  writeFileSync(config, `
    import config from ${JSON.stringify(path.resolve("playwright.config.ts"))};
    export default {
      testDir: ${JSON.stringify(dir)}, testMatch: ${JSON.stringify(path.basename(spec))}, workers: 1,
      webServer: {
        ...config.webServer[1], cwd: ${JSON.stringify(process.cwd())}, url: ${JSON.stringify(origin)},
        reuseExistingServer: false, stdout: 'pipe',
        env: { ...config.webServer[1].env, CONSOLE_WEB_PORT: '${port}' },
      },
      use: { browserName: 'chromium', headless: true },
      outputDir: ${JSON.stringify(path.join(dir, `results-${reason}`))},
    };
  `);
  writeFileSync(spec, `
    import { test, expect } from ${JSON.stringify(path.resolve("node_modules/@playwright/test/index.mjs"))};
    test('Vite responds in Chromium', async ({ page }) => {
      const response = await page.goto('${origin}');
      expect(response.ok()).toBe(true);
      await expect(page.locator('body')).toBeVisible();
      console.log('[web-test] ready');
      ${reason === "complete" ? "" : "await new Promise(() => {});"}
    });
  `);
  const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "-c", config], {
    env: { ...process.env, E2E_SERVED: "0", E2E_REUSE: "0" }, stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let group: number | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const observe = (data: Buffer) => {
      output += data;
      const match = output.match(/\[web\] process group (\d+) ready/);
      if (match) group = Number(match[1]);
      if (group && output.includes('[web-test] ready')) resolve();
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Playwright exited before readiness (${code ?? signal}): ${output}`)));
  });
  try {
    // Use the wrapper's group identity and Chromium's readiness, without a second startup deadline.
    await ready;
    expect(group, output).toBeGreaterThan(1);
    if (reason !== "complete") {
      expect(liveGroup(group!), output).not.toEqual([]);
      child.kill(reason);
    }
    const result = await exited;
    if (reason === "complete") expect(result, output).toEqual({ code: 0, signal: null });
    await expect.poll(() => liveGroup(group!), { timeout: 5_000 }).toEqual([]);
    await expect.poll(() => new Promise<boolean>((resolve, reject) => {
      const server = new net.Server();
      server.once("error", (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
      server.listen(port, "localhost", () => server.close(() => resolve(true)));
    }), { timeout: 5_000 }).toBe(true);
  } finally {
    // The fail-before run deliberately leaves Vite alive; clean only the group this test launched.
    if (group && group > 1) {
      try { process.kill(-group, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH" && liveGroup(group).length) throw error;
      }
    }
  }
}, 60_000);
