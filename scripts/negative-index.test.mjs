// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildIndex } from "./negative-index.mjs";

const contract = { paths: { "/api/v1/sample": { post: {
  description: "409 `sample_refused`; 403 no_grant",
  responses: { 422: { description: "422 `sample_invalid`" } },
} } } };
const ui = { file: "e2e/sample.spec.ts", source: `
  test.describe("sample", () => {
    test("refuses", async () => {
      const fixture = { code: "sample_invalid" };
      // expect(code).toBe("no_grant");
      expect(body.code).toBe("sample_refused");
    });
    test("another", async () => { expect(code).not.toBe("no_grant"); });
  });
  test.describe.skip("off", () => { test("refuses", () => expect(code).toBe("no_grant")); });` };
const be = { file: "backend/sample/tests/refusals.rs", binary: "sample::refusals", source: `
  #[tokio::test] async fn refuses() {
    let fixture = "sample_invalid";
    // assert_eq!(code, "no_grant");
    assert_eq!(body["error"]["code"], "sample_refused");
    assert_eq!(a, b, "no_grant");
  }
  #[test] fn another() { assert_ne!(code, "no_grant"); }` };

test("index joins positive literal assertions to their own test, retaining uncovered codes", () => {
  const rows = buildIndex(contract, [ui, be]);
  const row = rows.find(r => r.code === "sample_refused");
  assert.equal(row.operation, "POST /api/v1/sample");
  assert.deepEqual(row.ui, [{ file: ui.file, title: "sample › refuses" }]);
  assert.deepEqual(row.be, [{ file: be.file, title: "refuses", binary: be.binary }]);
  for (const code of ["sample_invalid", "no_grant"]) {
    assert.deepEqual(rows.find(r => r.code === code).ui, []);
    assert.deepEqual(rows.find(r => r.code === code).be, []);
  }
});

test("a planted documented refusal with no assertion stays uncovered", () => {
  assert.deepEqual(buildIndex({ paths: { "/new": { put: { description: "409 planted_refusal" } } } }, [ui, be]),
    [{ operation: "PUT /new", code: "planted_refusal", ui: [], be: [] }]);
});

test("Rust inline and external module names stay in the JUnit identity", () => {
  const sources = [{ ...be, prefix: ["external"], source: `mod inner { ${be.source} }` }];
  assert.equal(buildIndex(contract, sources).find(r => r.code === "sample_refused").be[0].title, "external::inner::refuses");
});

test("the solo flow names only implemented journeys and preserves audit as missing", () => {
  const source = readFileSync(new URL("../e2e/first-run-solo.spec.ts", import.meta.url), "utf8");
  for (let id = 0; id <= 10; id++) assert.match(source, new RegExp(`test\\.step\\("J${id} `));
  assert.doesNotMatch(source, /test\.step\("J11 /);
});

test("D7 evidence runs on dev pushes without adding a PR gate", async () => {
  const { default: yaml } = await import("js-yaml");
  const ci = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const backend = ci.jobs.backend.steps;
  const journey = backend.find(s => s.name === "Solo journey on Chromium and Firefox");
  for (const step of backend.filter(s => /D7|Solo journey/.test(s.name ?? "") || s.with?.name === "d7-playwright")) {
    assert.match(step.if, /github\.event_name == 'push'/);
    assert.match(step.if, /github\.ref == 'refs\/heads\/dev'/);
  }
  assert.match(journey.run, /for browser in 0 1/);
  assert.match(journey.run, /\|\| failed=1/);
  assert.match(journey.env.E2E_REPORTER, /json/);
  assert.ok(backend.findIndex(s => s.run === "node scripts/backend-tests.mjs") < backend.indexOf(journey));
  const job = ci.jobs["d7-evidence"];
  assert.equal(job.if, "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/dev' }}");
  assert.deepEqual(job.needs, ["backend", "states"]);
  assert.ok(job.steps.some(s => s.with?.name === "d7-evidence"));
  assert.ok(!ci.jobs["ci-ok"].needs.includes("d7-evidence"));
  assert.ok(!ci.jobs["ci-ok"].steps.some(s => s.run?.includes("needs.d7-evidence")));
});
