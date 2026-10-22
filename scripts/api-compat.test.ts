// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";

type Schema = { type?: string; enum?: string[]; "x-extensible-enum"?: string[]; required?: string[]; properties?: Record<string, Schema>; $ref?: string };
type Spec = { components: { schemas: Record<string, Schema> }; paths: Record<string, { post: { responses: Record<string, { content: { "application/json": { schema: Schema } } }> } }> };
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (source: string) => Spec };
const spec = yaml.load(readFileSync("backend/openapi/openapi.yaml", "utf8"));
const schemas = spec.components.schemas;
const responseBinding = schemas.MobilePasskeyStepUpStartResponse!.properties!.binding!.properties ?? schemas.MobilePasskeyStepUpBinding!.properties!;

test.each([
  ["step-up response action_kind", responseBinding.action_kind!, 12],
  ["step-up response reason_key", responseBinding.reason_key!, 12],
  ["EmployeeLifecycleEvent.leave_type", schemas.EmployeeLifecycleEvent!.properties!.leave_type!, 6],
  ["import leave_type", schemas.EmployeeImportPlannedRow!.properties!.new_person!.properties!.leave!.properties!.leave_type!, 5],
  ["leave request leave_type", schemas.LeaveRequestView!.properties!.leave_type!, 2],
  ["leave v2 leave_type", schemas.LeaveRequestV2View!.properties!.leave_type!, 2],
] as const)("%s permits future response values and retains every documented value", (_, schema, count) => {
  expect(schema.type).toBe("string");
  expect(schema.enum).toBeUndefined();
  expect(schema["x-extensible-enum"]).toHaveLength(count);
  expect(new Set(schema["x-extensible-enum"]).size).toBe(count);
});

test("exit confirmation 409 keeps the N-1 error object and optional schedule refusals", () => {
  const response = spec.paths["/api/v1/hr/exit-cases/{id}/confirm"]!.post.responses["409"]!.content["application/json"].schema;
  expect(response).toEqual({ $ref: "#/components/schemas/LifecycleScheduleConflictBody" });
  const body = schemas.LifecycleScheduleConflictBody!;
  expect(body.type).toBe("object");
  expect(body.required).toEqual(["error"]);
  expect(body.properties!.error!.required).toEqual(["code", "message"]);
  expect(body.properties!.error!.properties!.refusals).toBeDefined();
});

test("leave commands still reject misspelled known types", () => {
  expect(schemas.CreateEmployeeLifecycleEventRequest!.properties!.leave_type!.enum?.filter((v) => v !== null)).toEqual(schemas.EmployeeLifecycleEvent!.properties!.leave_type!["x-extensible-enum"]);
});

test("step-up command enums retain every value accepted by the response", () => {
  expect(schemas.MobileStepUpActionKind!.enum).toEqual(responseBinding.action_kind!["x-extensible-enum"]);
  expect(schemas.MobilePasskeyStepUpBinding!.properties!.reason_key!.enum).toEqual(responseBinding.reason_key!["x-extensible-enum"]);
});
