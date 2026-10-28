// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { expect, test } from "vitest";

test("the existing backend gate compares PRs and merge groups to their target tip", () => {
  const ci = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  expect(ci.on).toHaveProperty("pull_request");
  expect(ci.on).toHaveProperty("merge_group");
  const backend = ci.jobs.backend;
  expect(backend.env.MIGRATION_BASE).toBe("${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}");
  const checkout = backend.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  expect(checkout.with["fetch-depth"]).toBe(0);
  expect(backend.steps.some(step => step.run === "cargo test --locked -p console-gate-migration-safety")).toBe(true);
  expect(ci.jobs["ci-ok"].needs).toContain("backend");
});
