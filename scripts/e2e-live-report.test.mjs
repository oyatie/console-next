// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import { reportFailed, reportIdentities, specRows } from "./e2e-live-report.mjs";

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
    spec: "parallel/a.spec.ts", passed: 1, expectedFailures: 0, failed: 1, flaky: 1, skipped: 1, unexecuted: 0,
  }]);
});

test("missing execution and runner errors cannot look green", () => {
  const report = { errors: [{ message: "worker exited" }], suites: [{ file: "b.spec.ts", specs: [
    { title: "missing", tests: [{ ...result("skipped"), expectedStatus: "passed" }] },
  ] }] };
  const rows = specRows([report]);
  assert.deepEqual(rows, [{
    spec: "parallel/b.spec.ts", passed: 0, expectedFailures: 0, failed: 0, flaky: 0, skipped: 0, unexecuted: 1,
  }]);
  assert.equal(reportFailed([report], rows), true);
  assert.throws(() => specRows([{ errors: [], suites: [] }]), /no specs/);
});

test("each failing result independently fails the report", () => {
  const green = { passed: 1, expectedFailures: 0, failed: 0, flaky: 0, skipped: 0, unexecuted: 0 };
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
    spec: "parallel/c.spec.ts", passed: 0, expectedFailures: 0, failed: 0, flaky: 0, skipped: 0, unexecuted: 1,
  }]);
});


test("an expected failure is executed separately from a pass and an all-skipped shard fails", () => {
  const rowsFor = test => specRows([{suites: [{file: "a", specs: [{tests: [test]}]}]}]);
  const rows = rowsFor({...result("expected", "failed"), results: [{status: "failed"}]});
  assert.equal(rows[0].passed, 0);
  assert.equal(rows[0].expectedFailures, 1);
  assert.equal(reportFailed([{}], rows), false);
  assert.equal(reportFailed([{}], rowsFor(result("skipped", "skipped"))), true);
  assert.equal(reportFailed([{}], rowsFor({...result("expected"), results: []})), true);
});

test("live shard identities include project and nested specs and reject duplicates", () => {
  const suite = {suites: [{specs: [{id: "example", tests: [{projectName: "parallel"}]}]}]};
  assert.deepEqual(reportIdentities([suite]), [JSON.stringify(["parallel", "example"])]);
  assert.throws(() => reportIdentities([suite, suite]), /duplicate/);
});


test("the shard command rejects missing and surplus executions even when every reported test passed", t => {
  const directory = mkdtempSync(join(tmpdir(), "live-shard-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const expected = join(directory, "expected.json");
  const report = join(directory, "report.json");
  const spec = id => ({id, tests: [result("expected")]});
  writeFileSync(expected, JSON.stringify(reportIdentities([{specs: [spec("first"), spec("second")]}])));
  for (const [ids, passes] of [[["first", "second"], true], [["first"], false], [["first", "second", "third"], false]]) {
    writeFileSync(report, JSON.stringify({suites: [{file: "a.spec.ts", specs: ids.map(spec)}]}));
    const run = spawnSync(process.execPath, [join(import.meta.dirname, "e2e-live-report.mjs"), "--expected", expected, report], {encoding: "utf8"});
    assert.equal(run.status, passes ? 0 : 1, run.stderr);
    if (!passes) assert.match(run.stderr, /test identities differ/);
  }
});
