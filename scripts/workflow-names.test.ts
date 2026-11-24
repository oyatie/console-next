// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { load } from "js-yaml";

const workflows = Object.fromEntries(readdirSync(".github/workflows").filter(file => /\.ya?ml$/.test(file))
  .map(file => [file, load(readFileSync(`.github/workflows/${file}`, "utf8"))]));

test("each promotion environment selects existing workflows that can supply suite evidence", async () => {
  const { discoverEnvironments } = await import("../deploy/ci/promote.mjs");
  const { environmentSuites } = JSON.parse(readFileSync("deploy/gates.json", "utf8"));
  expect(Object.keys(environmentSuites).sort()).toEqual(discoverEnvironments().map(row => row.environment));
  for (const file of Object.values(environmentSuites).flat()) {
    const workflow = workflows[file];
    expect(workflow, file).toBeDefined();
    const triggers = typeof workflow.on === "string" ? [workflow.on]
      : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on);
    expect(triggers.some(event => ["push", "schedule", "workflow_dispatch"].includes(event)), file).toBe(true);
  }
});

function checkName(name: unknown, id: string, matrix = false) {
  expect(typeof name, `${id}: explicit name`).toBe("string");
  expect((name as string).trim(), `${id}: plain name`).not.toBe("");
  expect(name, `${id}: descriptive name`).not.toBe(id);
  if (matrix) {
    const expressions = (name as string).match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
    expect(expressions.length, `${id}: meaningful matrix value`).toBeGreaterThan(0);
    for (const expression of expressions) {
      expect(expression, `${id}: only named matrix values`).toMatch(/^\$\{\{\s*matrix\.[a-zA-Z_][a-zA-Z_0-9]*\s*\}\}$/);
      expect(expression, `${id}: timeouts belong in timeout-minutes`).not.toMatch(/timeout/i);
    }
  }
}

test.each(Object.entries(workflows))("%s gives every workflow and job a descriptive name", (file, workflow) => {
  checkName(workflow.name, file.replace(/\.ya?ml$/, ""));
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id === "ci-ok") expect(job.name).toBe("ci-ok");
    else checkName(job.name, id, !!job.strategy?.matrix);
  }
});

test.each([undefined, "", "  ", "tests"])("refuses missing or raw job name %s", name => {
  expect(() => checkName(name, "tests")).toThrow();
});

test.each([
  "UI state tests", "UI state tests · ${{ matrix }}", "UI state tests · ${{ toJSON(matrix) }}",
  "UI state tests · ${{ matrix.jobTimeoutMinutes }}", "UI state tests · ${{ matrix.runTimeoutMinutes }}",
  "UI state tests · ${{ matrix['jobTimeoutMinutes'] }}",
])("refuses ambiguous or timeout matrix name %s", name => {
  expect(() => checkName(name, "states", true)).toThrow();
});

test("accepts shard names and keeps timeout settings separate", () => {
  expect(() => checkName("UI state tests · shard ${{ matrix.shard }}", "states", true)).not.toThrow();
  expect(workflows["ci.yml"].jobs.states["timeout-minutes"]).toBe("${{ matrix.jobTimeoutMinutes }}");
});

test("required check contexts stay stable and workflow-name consumers match", () => {
  expect(workflows["ci.yml"].jobs["ci-ok"].name).toBe("ci-ok");
  expect(workflows["codeql.yml"].jobs["code-scanning"].name).toBe("Code scanning gate");
  const policy = JSON.parse(readFileSync(".github/release-admission-policy.json", "utf8"));
  expect(policy.push_ci.name).toBe(workflows[policy.push_ci.workflow].name);
  expect(workflows["promote.yml"].on.workflow_run.workflows).toEqual([workflows["platform.yml"].name]);
});

test("release gate policies select declared display names and steps", () => {
  const policy = JSON.parse(readFileSync("deploy/gates.json", "utf8"));
  for (const { workflow, job: name, step } of Object.values(policy.checks).flat()) {
    const matches = Object.values(workflows[workflow].jobs).filter(job => {
      const rows = job.strategy?.matrix?.include ?? [{}];
      return rows.some(row => job.name?.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key) => row[key]) === name);
    });
    expect(matches, name).toHaveLength(1);
    if (step) expect(matches[0].steps.filter(entry => entry.name === step), step).toHaveLength(1);
  }
});

test("measured evidence looks up the release job by its display name", () => {
  const source = readFileSync("scripts/pull-measured-evidence.sh", "utf8");
  expect(source).toContain(`jobs.get('${workflows["ci.yml"].jobs["release-evidence"].name}')`);
});
