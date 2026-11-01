// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { load } from "js-yaml";

test("lifecycle correction publishes the optional bound solo step-up", () => {
  const path = new URL("../backend/crates/orgchange/rest/openapi/paths/api__v1__employees__id__lifecycle-events__event_id__correct.post.yaml", import.meta.url);
  const operation = load(readFileSync(path, "utf8"));
  const schema = operation.requestBody.content["application/json"].schema;
  assert.equal(schema.properties.step_up.$ref, "#/components/schemas/MobilePasskeyStepUpEnvelope");
  assert.ok(!schema.required.includes("step_up"), "ordinary corrections and independent holders need no assertion");
  assert.ok(operation.responses["401"], "missing or invalid assertions are documented");
  assert.match(operation.description, /EXCEPTION_DECIDE/);
  assert.match(operation.description, /second_person_required/);
});

test("batch withdrawal documents forbidden and already-withdrawn responses", () => {
  const document = load(readFileSync(new URL("../backend/openapi/openapi.yaml", import.meta.url), "utf8"));
  const operation = document.paths["/api/v1/employees/lifecycle-events/bulk/{batch_id}/rescind"].post;
  assert.equal(operation.responses["403"].$ref, "#/components/responses/Forbidden");
  assert.equal(operation.responses["404"].$ref, "#/components/responses/NotFound");
});
