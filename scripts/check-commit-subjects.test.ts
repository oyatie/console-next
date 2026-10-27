// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { expect, test } from "vitest";

const read = (file: string) => yaml.load(readFileSync(new URL(`../.github/workflows/${file}.yml`, import.meta.url), "utf8"));

test("ci-ok cannot succeed when the reusable commit check fails or is skipped", () => {
  const ci = read("ci");
  expect(ci.on).toHaveProperty("pull_request");
  expect(ci.on).toHaveProperty("merge_group");
  expect(ci.jobs.commits.uses).toBe("./.github/workflows/commits.yml");
  expect(ci.jobs.commits.if).toBeUndefined();
  expect(ci.jobs.commits["continue-on-error"]).toBeUndefined();
  expect(ci.jobs.web.needs ?? []).not.toContain("commits");
  expect(ci.jobs.web.if).toBeUndefined();
  expect(ci.jobs["ci-ok"].needs).toContain("commits");
  expect(ci.jobs["ci-ok"].steps[0].run).toContain('test "${{ needs.commits.result }}" = success');
  expect(ci.jobs["ci-ok"].needs).toContain("web");
  expect(ci.jobs["ci-ok"].steps[0].run).toContain('test "${{ needs.web.result }}" = success');
});

test("the commit workflow checks event head commits with full history and read-only credentials", () => {
  const workflow = read("commits");
  expect(workflow.on).toHaveProperty("workflow_call");
  expect(workflow.permissions).toEqual({});
  const job = workflow.jobs.subjects;
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
