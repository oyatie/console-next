// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import yaml from "js-yaml";

test("CodeQL covers first-party languages outside the per-PR tier with a scoped upload token", () => {
  const workflow = yaml.load(readFileSync(".github/workflows/codeql.yml", "utf8"));
  const config = yaml.load(readFileSync(".github/codeql/codeql-config.yml", "utf8"));
  expect(Object.keys(workflow.on).sort()).toEqual(["push", "schedule"]);
  expect(workflow.on.push.branches).toEqual(["dev"]);
  expect(workflow.on.schedule).toHaveLength(1);
  expect(workflow.permissions).toEqual({});
  expect(Object.keys(workflow.jobs)).toEqual(["analyze"]);
  const analyze = workflow.jobs.analyze;
  expect(analyze.permissions).toEqual({ contents: "read", "security-events": "write" });
  expect(analyze.strategy.matrix.language).toEqual(["actions", "javascript-typescript", "python", "rust"]);
  expect(config["paths-ignore"]).toEqual(["third-party/**"]);
  const init = analyze.steps.find((step) => step.uses?.startsWith("github/codeql-action/init@"));
  expect(init.with["config-file"]).toBe("./.github/codeql/codeql-config.yml");
  expect(init.with["build-mode"]).toBe("none");
  for (const step of analyze.steps) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
});

test("the triage table retains the original 70 alerts and the four round-three PR alerts", () => {
  const rows = readFileSync("docs/security/code-scanning-triage.md", "utf8").split("\n")
    .filter((line) => line.startsWith("| [#"));
  expect(rows.map((row) => Number(row.match(/^\| \[#(\d+)\]/)![1]))).toEqual([
    ...Array.from({ length: 70 }, (_, i) => i + 1), 75, 76, 77, 78,
  ]);
  for (const row of rows) {
    const cells = row.split(" | ");
    expect(cells[3]).toMatch(/^(fixed in this PR|excluded by config|false positive)$/);
    expect(cells[4]!.replace(/ \|$/, "").length).toBeLessThanOrEqual(200);
  }
});
