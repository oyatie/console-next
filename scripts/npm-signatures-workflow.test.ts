// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { load } from "js-yaml";
import { expect, test } from "vitest";

const ci = load(readFileSync(".github/workflows/ci.yml", "utf8"));
const platform = load(readFileSync(".github/workflows/platform.yml", "utf8"));

function evaluate(expression: string, context: object) {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), context);
}

test.each(["pull_request", "merge_group"])("%s audits a changed or unclassified lockfile before web checks", event_name => {
  expect(ci.on[event_name]).toBeNull();
  const { affected, web } = ci.jobs;
  const paths = affected.steps.find(s => s.id === "paths");
  const event = {
    pull_request: { base: { sha: event_name === "pull_request" ? "pr-base" : "" } },
    merge_group: { base_sha: event_name === "merge_group" ? "queue-base" : "" },
  };
  const github = { event_name, event };
  expect(evaluate(paths.env.BASE_SHA, { github })).toBe(event_name === "pull_request" ? "pr-base" : "queue-base");
  expect(web.needs).toContain("affected");
  const install = web.steps.findIndex(s => s.run === "npm ci --no-audit --no-fund");
  const verify = web.steps.findIndex(s => s.run === "npm audit signatures");
  const checks = web.steps.findIndex(s => s.run === "npm run check");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(verify).toBeGreaterThan(install);
  expect(checks).toBeGreaterThan(verify);
  expect(web.steps[verify]["continue-on-error"]).toBeUndefined();

  for (const lockfile of ["true", "false", ""]) {
    const steps = { paths: { outputs: { web: "true", lockfile } }, import: { outputs: {} } };
    const outputs = Object.fromEntries(["web", "lockfile"].map(key =>
      [key, evaluate(affected.outputs[key] ?? "''", { steps }) ?? ""]));
    const context = { github, needs: { affected: { outputs } } };
    const runs = evaluate(web.if ?? "true", context) && evaluate(web.steps[verify].if ?? "true", context);
    expect(runs, `lockfile=${lockfile}`).toBe(lockfile !== "false");
  }
});

test("platform audits the installed dev lockfile on pushes and the weekly schedule", () => {
  expect(platform.on.push).toEqual({ branches: ["dev"] });
  expect(platform.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* [0-6]$/);
  const job = platform.jobs["npm-signatures"];
  expect(job, "dedicated signature audit").toBeDefined();
  const install = job.steps.findIndex(s => s.run === "npm ci --ignore-scripts --no-audit --no-fund");
  const verify = job.steps.findIndex(s => s.run === "npm audit signatures");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(verify).toBeGreaterThan(install);
  expect(job["continue-on-error"]).toBeUndefined();
  expect(job.steps[verify]["continue-on-error"]).toBeUndefined();
  for (const event_name of ["push", "schedule", "pull_request", "merge_group", "workflow_dispatch", "workflow_call"]) {
    const context = { github: { event_name } };
    const runs = evaluate(job.if ?? "true", context) && evaluate(job.steps[verify].if ?? "true", context);
    expect(runs, event_name).toBe(["push", "schedule"].includes(event_name));
  }
});
