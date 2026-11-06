// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { actionRegistry, censusRows } from "./d10-census.mjs";
import { scanRustSyntax } from "./check-request-body-contract.mjs";

test("workspace preferences and offline sync name their enrolled Cedar actions", () => {
  for (const [fragment, permission, action] of [
    ["financial/rest/openapi/paths/api__v1__financial__purchase-requests__preferences.put.yaml", "PurchaseRequestRead", "purchase_request_read"],
    ["workorder/rest/openapi/paths/api__v1__sync.post.yaml", "WorkOrderStart", "work_order_start"],
  ]) {
    const contract = yaml.load(readFileSync(new URL(`../backend/crates/${fragment}`, import.meta.url), "utf8"));
    assert.equal(contract["x-console-authz"]?.engine, "cedar");
    assert.equal(contract["x-console-authz"]?.permission, permission);
    assert.equal(contract["x-console-authz"]?.action, action);
    assert.ok(contract.responses["403"]);
  }
});

test("every write survives, with registered actions from its own handler only", () => {
  const rest = [
    { method: "POST", path: "/sample", handler: "create", handlerFile: "sample.rs", models: ["Cedar"] },
    { method: "DELETE", path: "/unknown", handler: null, models: [] },
    { method: "GET", path: "/sample", models: [] },
  ];
  const fn = (name, body, modulePath = []) => ({ file: "sample.rs", graphRoot: "sample", modulePath, imports: [], name,
    body, code: scanRustSyntax(body, { projectCode: true }).projection });
  const functions = [fn("create", `{
      // Feature::Unregistered
      let text = "Feature::Unregistered";
      auth::check();
    }`), fn("check", "{ enforce_action(Feature::SampleWrite); }", ["auth"]),
    fn("other", "{ enforce_action(Feature::OtherWrite); }")];
  const rows = censusRows(rest, 'Self::SampleWrite => "sample_write",', functions);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(r => r.operation === "POST /sample").cedar_actions, ["sample_write"]);
  assert.deepEqual(rows.find(r => r.operation === "DELETE /unknown").cedar_actions, []);
  assert.deepEqual(censusRows([rest[0]], 'Self::SampleWrite => "sample_write",', [fn("create", "{ authorize(Feature::SampleWrite); }")])[0].cedar_actions, []);
  assert.deepEqual(censusRows([rest[0]], 'Self::SampleWrite => "sample_write",', [...functions, functions[0]])[0].cedar_actions, []);
});

test("D10 reuses report artifacts and approved actions on dev pushes", () => {
  const ci = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const job = ci.jobs["d10-evidence"];
  assert.deepEqual(job.needs, ["d7-evidence", "d10-probes"]);
  assert.ok(job.steps.some(s => s.run?.includes("scripts/d10-census.mjs")));
  assert.ok(job.steps.some(s => s.run?.includes("scripts/d10-evidence.py")));
  const upload = job.steps.find(s => s.with?.name === "d10-evidence");
  assert.ok(upload);
  assert.equal(upload.uses, ci.jobs["d7-evidence"].steps.find(s => s.with?.name === "d7-evidence").uses);
  assert.ok(job.steps.some(s => s.with?.name === "d7-evidence" && s.with.path === ".cache/d7-evidence"));
  assert.match(job.if, /github.event_name == 'push'/);
  assert.match(job.if, /refs\/heads\/dev/);
  assert.ok(ci.jobs.web.steps.some(s => s.run?.includes("scripts/d10_evidence_test.py")));
});

test("wire names without enrollment in the Cedar action registry stay unresolved", () => {
  const sources = {
    "feature/names.rs": 'Self::SampleWrite => "sample_write",\nSelf::LegacyWrite => "legacy_write",',
    "cedar_pbac/actions/mod.rs": 'pub const ACTION_SCHEMAS: &[ActionSchema] = &[\n    sample::SCHEMA,\n    // legacy::SCHEMA,\n];\n const OTHER: &[ActionSchema] = &[legacy::SCHEMA];',
    "cedar_pbac/actions/sample.rs": 'pub const SCHEMA: ActionSchema = ActionSchema { feature: Feature::SampleWrite };',
  };
  const registry = actionRegistry(file => sources[file]);
  assert.match(registry, /SampleWrite/);
  assert.doesNotMatch(registry, /LegacyWrite/);
});

test("dev write probes reuse the E2E backend and feed the existing evidence producer even on failure", () => {
  const ci = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const job = ci.jobs["d10-probes"];
  assert.ok(job, "a live D10 probe job is required");
  assert.match(job.if, /github.event_name == 'push'/);
  assert.match(job.if, /refs\/heads\/dev/);
  assert.equal(job["runs-on"], ci.jobs["backend-release"]["runs-on"]);
  assert.ok(job.needs.includes("backend-release"));
  const execute = job.steps.find(s => s.run?.includes("authz/write-refusals.spec.ts"));
  assert.match(execute.run, /--project=parallel/);
  assert.equal(execute.env.E2E_REPORTER, "line,json");
  assert.equal(execute.env.CONSOLE_APP_BIN, ".cache/d10-backend/console-app");
  assert.ok(job.steps.some(s => s.with?.name === "d10-playwright" && s.if?.includes("!cancelled()")));
  const evidence = ci.jobs["d10-evidence"];
  assert.ok(evidence.needs.includes("d10-probes"));
  assert.ok(evidence.steps.some(s => s.with?.name === "d10-playwright" && s.with.path === ".cache/d10-input"));
  const approved = new Set(Object.values(ci.jobs).filter(j => j !== job).flatMap(j => j.steps ?? []).map(s => s.uses).filter(Boolean));
  for (const step of job.steps) if (step.uses) assert.ok(approved.has(step.uses), step.uses);
});
