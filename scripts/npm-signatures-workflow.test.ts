// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";

const ci = load(readFileSync(".github/workflows/ci.yml", "utf8"));
const platform = load(readFileSync(".github/workflows/platform.yml", "utf8"));

test("candidate web checks audit changed lockfiles and fail safe without a classification", () => {
  expect(ci.on.pull_request).toBeNull();
  expect(ci.on.merge_group).toBeNull();
  const { affected, web } = ci.jobs;
  const paths = affected.steps.find(s => s.id === "paths");
  expect(paths.env.BASE_SHA).toBe("${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}");
  expect(affected.outputs.lockfile).toBe("${{ steps.paths.outputs.lockfile }}");
  expect(web.needs).toContain("affected");
  const install = web.steps.findIndex(s => s.run === "npm ci --no-audit --no-fund");
  const verify = web.steps.findIndex(s => s.run === "npm audit signatures");
  const checks = web.steps.findIndex(s => s.run === "npm run check");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(verify).toBeGreaterThan(install);
  expect(checks).toBeGreaterThan(verify);
  expect(web.steps[verify].if).toBe("needs.affected.outputs.lockfile != 'false'");
  expect(web.steps[verify]["continue-on-error"]).toBeUndefined();
});

test("platform validation audits the installed dev lockfile on each push and weekly", () => {
  expect(platform.on.push).toEqual({ branches: ["dev"] });
  expect(platform.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* [0-6]$/);
  const { validate } = platform.jobs;
  expect(validate.if).toBeUndefined();
  const checkout = validate.steps.find(s => s.uses?.startsWith("actions/checkout@"));
  expect(checkout.with.ref).toBe("${{ github.event_name == 'schedule' && 'refs/heads/dev' || github.sha }}");
  const install = validate.steps.findIndex(s => s.run === "npm ci --ignore-scripts --no-audit --no-fund");
  const verify = validate.steps.findIndex(s => s.run === "npm audit signatures");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(verify).toBeGreaterThan(install);
  expect(validate.steps[verify].if).toBe("github.event_name == 'push' || github.event_name == 'schedule'");
  expect(validate.steps[verify]["continue-on-error"]).toBeUndefined();
});
