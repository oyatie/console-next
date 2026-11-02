// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import test from "node:test";
import { reportFailed, specRows } from "./e2e-live-report.mjs";

const result = (status, expectedStatus = "passed") => ({
  projectName: "parallel",
  status,
  expectedStatus,
  results: status === "skipped" ? [] : [{ status: status === "unexpected" ? "failed" : "passed" }],
});

test("reports pass, fail, flaky and deliberate skip counts per project and spec", () => {
  const report = { errors: [], suites: [{ file: "a.spec.ts", specs: [
    { title: "pass", tests: [result("expected")] },
    { title: "fail", tests: [result("unexpected")] },
    { title: "flake", tests: [result("flaky")] },
    { title: "skip", tests: [result("skipped", "skipped")] },
  ] }] };
  assert.deepEqual(specRows([report]), [{
    spec: "parallel/a.spec.ts", passed: 1, failed: 1, flaky: 1, skipped: 1, unexecuted: 0,
  }]);
});

test("missing execution and runner errors cannot look green", () => {
  const report = { errors: [{ message: "worker exited" }], suites: [{ file: "b.spec.ts", specs: [
    { title: "missing", tests: [{ ...result("skipped"), expectedStatus: "passed" }] },
  ] }] };
  const rows = specRows([report]);
  assert.deepEqual(rows, [{
    spec: "parallel/b.spec.ts", passed: 0, failed: 0, flaky: 0, skipped: 0, unexecuted: 1,
  }]);
  assert.equal(reportFailed([report], rows), true);
  assert.throws(() => specRows([{ errors: [], suites: [] }]), /no specs/);
});

test("each failing result independently fails the report", () => {
  const green = { passed: 1, failed: 0, flaky: 0, skipped: 0, unexecuted: 0 };
  assert.equal(reportFailed([{ errors: [{ message: "worker exited" }] }], [green]), true, "runner error");
  for (const field of ["failed", "flaky", "unexecuted"]) {
    assert.equal(reportFailed([{ errors: [] }], [{ ...green, [field]: 1 }]), true, field);
  }
  assert.equal(reportFailed([{ errors: [] }], [green]), false, "green report");
});

test("an interrupted result is unexecuted", () => {
  const report = { errors: [], suites: [{ file: "c.spec.ts", specs: [{
    title: "interrupted",
    tests: [{ ...result("expected"), results: [{ status: "interrupted" }] }],
  }] }] };
  assert.deepEqual(specRows([report]), [{
    spec: "parallel/c.spec.ts", passed: 0, failed: 0, flaky: 0, skipped: 0, unexecuted: 1,
  }]);
});
