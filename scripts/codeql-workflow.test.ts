// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import yaml from "js-yaml";

test("CodeQL covers PR merge commits and merge groups with a scoped upload token", () => {
  const workflow = yaml.load(readFileSync(".github/workflows/codeql.yml", "utf8"));
  const config = yaml.load(readFileSync(".github/codeql/codeql-config.yml", "utf8"));
  expect(Object.keys(workflow.on).sort()).toEqual(["merge_group", "pull_request", "push", "schedule"]);
  expect(workflow.on).not.toHaveProperty("pull_request_target");
  expect(workflow.on.pull_request).toBeNull();
  expect(workflow.on.merge_group.types).toEqual(["checks_requested"]);
  expect(workflow.on.push.branches).toEqual(["dev"]);
  expect(workflow.on.schedule).toHaveLength(1);
  expect(workflow.permissions).toEqual({});
  expect(Object.keys(workflow.jobs)).toEqual(["analyze", "code-scanning"]);
  const analyze = workflow.jobs.analyze;
  expect(analyze.permissions).toEqual({ contents: "read", "security-events": "write" });
  const languages = /'(\[[^']*\])' \|\| '(\[[^']*\])'/.exec(analyze.strategy.matrix.language);
  expect(analyze.strategy.matrix.language).toMatch(/^\$\{\{ fromJSON\(\(github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group'\) && /);
  expect(JSON.parse(languages![1])).toEqual(["actions", "javascript-typescript", "python"]);
  expect(JSON.parse(languages![2])).toEqual(["actions", "javascript-typescript", "python", "rust"]);
  expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  expect(config["paths-ignore"]).toEqual(["third-party/**", "backend/**/tests/**", "e2e/**", "**/*.test.*"]);
  const excluded = (file: string) => config["paths-ignore"].some((pattern: string) => matchesGlob(file, pattern));
  for (const file of ["backend/app/tests/api.rs", "backend/crates/platform/auth/tests/session.rs", "e2e/photo.spec.ts", "scripts/hygiene.test.ts"])
    expect(excluded(file), file).toBe(true);
  for (const file of ["backend/crates/platform/auth/src/lib.rs", "apps/web/src/auth/session.ts", "scripts/check-korean-institutional-connectivity.mjs"])
    expect(excluded(file), file).toBe(false);
  const init = analyze.steps.find((step) => step.uses?.startsWith("github/codeql-action/init@"));
  expect(init.with["config-file"]).toBe("./.github/codeql/codeql-config.yml");
  expect(init.with["build-mode"]).toBe("none");
  const checkout = analyze.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout.with).toEqual({ "persist-credentials": false, "fetch-depth": 0 });
  const scanIndex = analyze.steps.findIndex((step) => step.uses?.startsWith("github/codeql-action/analyze@"));
  const scan = analyze.steps[scanIndex];
  expect(scan.with.output).toBe("${{ runner.temp }}/codeql-results");
  const gate = analyze.steps[scanIndex + 1];
  expect(gate.if).toBe("${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}");
  expect(gate.env.CODEQL_BASE).toBe("${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}");
  expect(gate.env.CODEQL_RESULTS).toBe(scan.with.output);
  expect(gate.run).toBe('node scripts/check-codeql-diff.mjs "$CODEQL_RESULTS" "$CODEQL_BASE"');
  for (const step of analyze.steps.filter((step) => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  expect(analyze["continue-on-error"]).toBeUndefined();
  expect(gate["continue-on-error"]).toBeUndefined();
  const aggregate = workflow.jobs["code-scanning"];
  expect(aggregate.name).toBe("Code scanning gate");
  expect(aggregate.needs).toEqual(["analyze"]);
  expect(aggregate.if).toBe("${{ always() }}");
  expect(aggregate.steps[0].uses).toMatch(/^step-security\/harden-runner@[a-f0-9]{40}$/);
  expect(aggregate.steps.slice(1)).toEqual([{
    name: "Require every language analysis and diff gate",
    env: { ANALYZE_RESULT: "${{ needs.analyze.result }}" },
    run: 'test "$ANALYZE_RESULT" = success',
  }]);
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const check = spawnSync("bash", ["-c", aggregate.steps[1].run], { env: { ...process.env, ANALYZE_RESULT: result } });
    expect(check.status, result).toBe(result === "success" ? 0 : 1);
  }
});

test("the triage table retains historical alerts and the 18 newer test findings", () => {
  const rows = readFileSync("docs/security/code-scanning-triage.md", "utf8").split("\n")
    .filter((line) => line.startsWith("| [#"));
  expect(rows.map((row) => Number(row.match(/^\| \[#(\d+)\]/)![1]))).toEqual([
    ...Array.from({ length: 70 }, (_, i) => i + 1), 75, 76, 77, 78, 79, 80, 82,
    ...Array.from({ length: 17 }, (_, i) => i + 88),
  ]);
  for (const row of rows) {
    const cells = row.split(" | ");
    expect(cells[3]).toMatch(/^(fixed in this PR|excluded by config|false positive)$/);
    expect(cells[4]!.replace(/ \|$/, "").length).toBeLessThanOrEqual(200);
  }
});
