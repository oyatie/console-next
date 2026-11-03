// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("perf is opt-in without hiding the performance CI probe", () => {
  for (const [spec, enabled, count] of [
    ["e2e/performance/home-inbox.spec.ts", false, 1],
    ["e2e/perf/route-load.spec.ts", false, 0],
    ["e2e/perf/route-load.spec.ts", true, 3],
  ] as const) {
    const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", spec,
      "--project=parallel", "--list", "--reporter=list", "--pass-with-no-tests"], {
      env: { ...process.env, E2E_XBROWSER: "0", E2E_PERF: enabled ? "1" : "0" }, encoding: "utf8", timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, spec).toContain(`Total: ${count} test`);
  }
}, 60_000);
