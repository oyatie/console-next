// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("perf is opt-in without hiding the performance CI probe", () => {
  for (const [spec, enabled, xbrowser, project, count] of [
    ["e2e/performance/home-inbox.spec.ts", false, false, "parallel", 1],
    ["e2e/perf/route-load.spec.ts", false, false, "parallel", 0],
    ["e2e/perf/route-load.spec.ts", true, false, "parallel", 4],
    ["e2e/perf/selection.test.ts", false, true, "firefox", 0],
  ] as const) {
    const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", spec,
      `--project=${project}`, "--list", "--reporter=list", "--pass-with-no-tests"], {
      env: { ...process.env, E2E_XBROWSER: xbrowser ? "1" : "0", E2E_PERF: enabled ? "1" : "0" }, encoding: "utf8", timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, spec).toContain(`Total: ${count} test`);
  }
}, 60_000);
