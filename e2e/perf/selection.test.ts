// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

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
