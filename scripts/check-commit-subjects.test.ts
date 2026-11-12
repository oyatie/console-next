// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { expect, test } from "vitest";

const read = (file: string) => yaml.load(readFileSync(new URL(`../.github/workflows/${file}.yml`, import.meta.url), "utf8"));

test("ci-ok cannot succeed when the reusable commit check fails or is skipped", () => {
  const ci = read("ci");
  expect(ci.on).toHaveProperty("pull_request");
  expect(ci.on).toHaveProperty("merge_group");
  expect(ci.jobs.workflows.uses).toBe("./.github/workflows/workflows-check.yml");
  expect(ci.jobs.workflows.if).toBe("github.event_name != 'push'");
  expect(ci.jobs.workflows["continue-on-error"]).toBeUndefined();
  expect(ci.jobs.web.needs ?? []).not.toContain("workflows");
  expect(ci.jobs.web.if).toContain("needs.affected.outputs.web == 'true'");
  expect(ci.jobs["ci-ok"].needs).toContain("workflows");
  expect(ci.jobs["ci-ok"].needs).toContain("web");
  for (const name of ["workflows", "web"]) for (const result of ["success", "failure", "skipped", "cancelled"]) {
    const needs = Object.fromEntries(ci.jobs["ci-ok"].needs.map(job => [job, { result: job === name ? result : ["states-timings", "dev-artifacts", "backend-cache", "release-evidence"].includes(job) ? "skipped" : "success", outputs: { backend: "true", web: "true" } }]));
    expect(spawnSync("bash", ["-e", "-c", ci.jobs["ci-ok"].steps[0].run], { env: { ...process.env, NEEDS: JSON.stringify(needs), GITHUB_EVENT_NAME: "pull_request" } }).status).toBe(result === "success" ? 0 : 1);
  }
});

test("the commit workflow checks event head commits with full history and read-only credentials", () => {
  const workflow = read("workflows-check");
  expect(workflow.on).toHaveProperty("workflow_call");
  expect(workflow.permissions).toEqual({});
  const job = workflow.jobs.workflows;
  const lint = job.steps.find((step) => step.name === "actionlint");
  expect(lint.run).toContain("rhysd/actionlint@sha256:");
  expect(lint.if).toBeUndefined();
  expect(lint["continue-on-error"]).toBeUndefined();
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job.if).toBeUndefined();
  expect(job["continue-on-error"]).toBeUndefined();
  for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout.with).toEqual({ "fetch-depth": 0, "persist-credentials": false });
  expect(job.steps.some((step) => step.run === "node --test scripts/check-commit-subjects.test.mjs")).toBe(true);
  const check = job.steps.find((step) => step.name === "Check every new commit subject");
  expect(check.if).toBe("github.event_name == 'pull_request' || github.event_name == 'merge_group'");
  expect(check.env.COMMIT_BASE).toBe("${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}");
  expect(check.env.COMMIT_HEAD).toBe("${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}");
  expect(check.env.COMMIT_EVENT).toBe("${{ github.event_name }}");
  expect(check.run).toBe('node scripts/check-commit-subjects.mjs "$COMMIT_BASE" "$COMMIT_HEAD" "$COMMIT_EVENT"');
  expect(check["continue-on-error"]).toBeUndefined();
});
