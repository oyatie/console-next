// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";

type Schema = { type?: string; enum?: string[]; "x-extensible-enum"?: string[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema; $ref?: string };
type Spec = { components: { schemas: Record<string, Schema> }; paths: Record<string, { post: { responses: Record<string, { content: { "application/json": { schema: Schema } } }> } }> };
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (source: string) => Spec };
const spec = yaml.load(readFileSync("backend/openapi/openapi.yaml", "utf8"));
const schemas = spec.components.schemas;

const responseBinding = schemas.MobilePasskeyStepUpStartResponse!.properties!.binding!.properties ?? schemas.MobilePasskeyStepUpBinding!.properties!;

test("emergency contact PATCH accepts released clients without weakening notice responses", () => {
  const items = schemas.CorrectEmployeeRequest!.properties!.changes!.properties!.emergency_contacts!.items!;
  const input = items.$ref ? schemas[items.$ref.split("/").pop()!]! : items;
  const output = schemas.EmergencyContact!;
  expect(input.required).not.toContain("contact_notified");
  expect(input.properties!.contact_notified!.type).toBe("boolean");
  expect(output.required).toContain("contact_notified");
  for (const field of ["name", "relation", "phone"]) {
    expect(input.required).toContain(field);
    expect(input.properties![field]).toEqual(output.properties![field]);
  }
});

test("schedule tree truth adds optional fields without changing the existing layer contract", () => {
  const node = schemas.AttendanceScheduleTreeNode!;
  expect(node.required).toEqual(["kind", "id", "name", "people"]);
  expect(node.properties!.layer).toEqual({ $ref: "#/components/schemas/AttendanceLayerSummary", nullable: true });
  expect(node.properties!.unscheduled?.type).toBe("integer");
  expect(node.properties!.workplace_id).toMatchObject({ $ref: "#/components/schemas/Uuid", nullable: true });
  expect(node.properties!.effective).toMatchObject({ nullable: true, allOf: [
    { $ref: "#/components/schemas/AttendanceLayerSummary" },
    { required: ["from"], properties: { from: { $ref: "#/components/schemas/AttendanceScopeKind" } } },
  ] });
});

test("current user adds optional tenant facts without changing directory or platform rows", () => {
  const current = schemas.CurrentUser as Schema & { allOf: Schema[] };
  expect(current.allOf[0]).toEqual({ $ref: "#/components/schemas/UserSummary" });
  expect(current.allOf[1]!.required ?? []).not.toContain("tenant");
  expect(current.allOf[1]!.properties!.tenant).toEqual({ $ref: "#/components/schemas/UserTenant" });
  expect(schemas.UserSummary!.properties!.tenant).toBeUndefined();
  expect(schemas.UserPage!.properties!.items).toEqual({ type: "array", items: { $ref: "#/components/schemas/UserSummary" } });
  expect(schemas.UserTenant!.required).toEqual(["name", "phase", "go_live_at"]);
  expect(schemas.UserTenant!.properties!.phase!["x-extensible-enum"]).toEqual(["SETUP", "OPERATING"]);
});

test("filing identity and opening countdown are additive response fields for N-1 readers", () => {
  const filing = schemas.InsuranceFilingTask!;
  expect(filing.properties!.filing_obligation_id).toEqual({ type: "string", format: "uuid", nullable: true });
  expect(filing.properties!.opens_in_days).toEqual({ type: "integer", format: "int64", nullable: true });
  expect(filing.required).not.toContain("filing_obligation_id");
  expect(filing.required).not.toContain("opens_in_days");
});

test.each([
  ["step-up response action_kind", responseBinding.action_kind!, 15],
  ["step-up response reason_key", responseBinding.reason_key!, 15],
  ["EmployeeLifecycleEvent.leave_type", schemas.EmployeeLifecycleEvent!.properties!.leave_type!, 6],
  ["import leave_type", schemas.EmployeeImportPlannedRow!.properties!.new_person!.properties!.leave!.properties!.leave_type!, 5],
  ["leave request leave_type", schemas.LeaveRequestView!.properties!.leave_type!, 2],
  ["leave v2 leave_type", schemas.LeaveRequestV2View!.properties!.leave_type!, 2],
  ["change request kind", schemas.ChangeRequest!.properties!.kind!, 9],
  ["change request subject_type", schemas.ChangeRequest!.properties!.subject_type!, 5],
  ["access domain", schemas.AccessDomain!, 19],
  ["action inbox source", schemas.ActionInboxItem!.properties!.kind!, 45],
] as const)("%s permits future response values and retains every documented value", (_, schema, count) => {
  expect(schema.type).toBe("string");
  expect(schema.enum).toBeUndefined();
  expect(schema["x-extensible-enum"]).toHaveLength(count);
  expect(new Set(schema["x-extensible-enum"]).size).toBe(count);
});

test("consent accepts the N-1 request shape for typed legacy refusal", () => {
  expect(schemas.PrivacyConsentAcceptRequest!.required).toEqual(["privacy_collection", "terms_of_service"]);
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

test("org decision 409 is one object preserving the N-1 error and optional refusal details", () => {
  const response = spec.paths["/api/v1/org-changes/{id}/approval-steps/{stepId}/decision"]!.post.responses["409"]!.content["application/json"].schema;
  expect(response).toEqual({ $ref: "#/components/schemas/ErrorBody" });
  expect(schemas.ErrorBody!.type).toBe("object");
  expect(schemas.ErrorBody!.required).toEqual(["error"]);
  expect(schemas.ErrorBody).not.toHaveProperty("anyOf");
  expect(schemas.ErrorBody).not.toHaveProperty("oneOf");
  expect(schemas.ErrorBody!.properties!.error!.properties!.details).toEqual({ type: "object", properties: {
    current_version: { type: "string", description: "Current opaque decision version; re-read the document before deciding again." },
  } });
  expect(schemas.ErrorBody!.properties!.error!.required).toEqual(["code", "message"]);
  expect(schemas.ErrorBody!.properties!.error!.properties!.current_version!.type).toBe("integer");
});

test("leave commands still reject misspelled known types", () => {
  expect(schemas.CreateEmployeeLifecycleEventRequest!.properties!.leave_type!.enum?.filter((v) => v !== null)).toEqual(schemas.EmployeeLifecycleEvent!.properties!.leave_type!["x-extensible-enum"]);
});

test("step-up command enums retain every value accepted by the response", () => {
  expect(schemas.MobileStepUpActionKind!["x-extensible-enum"]).toEqual(responseBinding.action_kind!["x-extensible-enum"]);
  expect(schemas.MobilePasskeyStepUpBinding!.properties!.reason_key!["x-extensible-enum"]).toEqual(responseBinding.reason_key!["x-extensible-enum"]);
});


test("the access contract publishes the support approval domain", () => {
  expect(schemas.AccessDomain!["x-extensible-enum"]).toContain("support_access");
  expect(schemas.AccessRoleLineInput!.properties!.domain!.enum).toEqual(schemas.AccessDomain!["x-extensible-enum"]);
});

test("RRN display duration is optional for N-1 clients and bounded by the registry", () => {
  const revealed = schemas.EmployeeRrnRevealed!;
  expect(revealed.required).toEqual(["employee_id", "rrn"]);
  expect(revealed.properties!.display_seconds).toMatchObject({ type: "integer", minimum: 15, maximum: 60 });
});

test("day detail adds only an optional row-density query and leaves the response contract intact", () => {
  const path = spec.paths["/api/v1/attendance/days"] as unknown as { get: { parameters: { name: string; required: boolean; schema: Schema }[]; responses: Record<string, unknown> } };
  expect(path.get.parameters.find(p => p.name === "rows")).toEqual({
    name: "rows", in: "query", required: false,
    description: "return every row without folding normal people; existing filters still apply",
    schema: { type: "string", enum: ["all"] },
  });
  expect(path.get.parameters.filter(p => p.required).map(p => p.name)).toEqual(["date"]);
  expect(path.get.responses["200"]).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/AttendanceDayBoard" } } } });
});
