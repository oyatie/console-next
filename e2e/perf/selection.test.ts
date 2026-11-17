// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import config from "../../playwright.config";

test("perf is opt-in without hiding the performance CI probe", () => {
  for (const [spec, enabled, browser, project, count] of [
    ["e2e/performance/home-inbox.spec.ts", false, "chromium", "parallel", 1],
    ["e2e/perf/route-load.spec.ts", false, "chromium", "parallel", 0],
    ["e2e/perf/route-load.spec.ts", true, "chromium", "parallel", 4],
    ["e2e/perf/selection.test.ts", false, "firefox", "firefox", 0],
    ["e2e/perf/route-load.spec.ts", true, "webkit", "webkit", 4],
  ] as const) {
    const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", spec,
      `--project=${project}`, "--list", "--reporter=list", "--pass-with-no-tests"], {
      env: { ...process.env, E2E_BROWSER: browser, E2E_PERF: enabled ? "1" : "0" }, encoding: "utf8", timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, spec).toContain(`Total: ${count} test`);
  }
}, 60_000);

test("the paired perf profile alone trusts the ephemeral TLS certificate", async () => {
  const perf = (await import("../../playwright.perf.config")).default;
  expect(config.use?.ignoreHTTPSErrors).toBeUndefined();
  expect(perf.projects).toHaveLength(1);
  expect(perf.projects?.[0]?.use?.ignoreHTTPSErrors).toBe(true);
  expect(perf.projects?.[0]?.use?.baseURL).toMatch(/^https:\/\/localhost:/);
  expect(perf.webServer).toHaveLength(2);
  const workflow = readFileSync(new URL("../../.github/workflows/route-load.yml", import.meta.url), "utf8");
  expect(workflow).toContain("--config=playwright.perf.config.ts");
});
