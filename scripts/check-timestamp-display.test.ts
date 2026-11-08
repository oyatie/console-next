// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, it } from "vitest";
import { checkTimestampContract, responseTimestampProblems, timestampContract, timestampProblems } from "./check-timestamp-display.mjs";

const spec = {
  paths: { "/events": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Page" } } } } } } } },
  components: { schemas: {
    Instant: { type: "string", format: "date-time" },
    Page: { properties: { entries: { type: "array", items: { properties: { observed: { $ref: "#/components/schemas/Instant" }, maybe: { anyOf: [{ $ref: "#/components/schemas/Instant" }, { type: "null" }] } } } } } },
  } },
};

it.each(["2026-11-05 3:31:02.238349 +00:00:00", "", [2026, 309, 3, 31, 2, 238349000, 0, 0, 0], null, 0, "2026-11-05T12:31:02+09:00", "2026-11-05T03:31:02+00:00", "2026-02-30T00:00:00Z"])("rejects a non-contract timestamp without relying on its name: %j", observed => {
  expect(responseTimestampProblems(spec, "/events", "GET", 200, { entries: [{ observed }] })).toHaveLength(1);
});
it("accepts fractional UTC timestamps, nullable fields and omitted optional fields", () => {
  expect(responseTimestampProblems(spec, "/events", "GET", 200, { entries: [{ observed: "2026-11-05T03:31:02.238349Z", maybe: null }, {}] })).toEqual([]);
});
it("checks nested compositions and timestamp maps", () => {
  const schema = { allOf: [{ additionalProperties: { $ref: "#/components/schemas/Instant" } }] };
  expect(timestampProblems(spec, schema, { observed: "" })).toHaveLength(1);
});
it("refuses non-string date-time response schemas, including behind refs", () => {
  const broken = structuredClone(spec);
  broken.components.schemas.Instant.type = "array";
  expect(checkTimestampContract(broken)).toHaveLength(1);
  expect(checkTimestampContract(spec)).toEqual([]);
});
it("every OpenAPI response date-time has a string wire type", () => {
  expect(checkTimestampContract(timestampContract)).toEqual([]);
});

it("checks the matching discriminated response variant", () => {
  const schema = { oneOf: [
    { type: "object", required: ["kind"], properties: { kind: { const: "instant" }, observed: { $ref: "#/components/schemas/Instant" } } },
    { type: "object", required: ["kind"], properties: { kind: { const: "label" }, observed: { type: "string" } } },
  ] };
  expect(timestampProblems(spec, schema, { kind: "instant", observed: "" })).toHaveLength(1);
  expect(timestampProblems(spec, schema, { kind: "label", observed: "label" })).toEqual([]);
});

it("resolves parameterized paths and ignores query parameters and non-JSON responses", () => {
  const routed = structuredClone(spec) as typeof spec & { paths: Record<string, unknown> };
  routed.paths["/events/{id}"] = routed.paths["/events"];
  expect(responseTimestampProblems(routed, "/events/one?limit=1", "get", 200, { entries: [{ observed: "" }] })).toHaveLength(1);
  expect(responseTimestampProblems(routed, "/events.csv", "get", 200, "csv")).toEqual([]);
});

it("follows schema aliases to the timestamp format", () => {
  const aliased = structuredClone(spec) as typeof spec & { components: { schemas: Record<string, unknown> } };
  aliased.components.schemas.Alias = { $ref: "#/components/schemas/Instant" };
  expect(timestampProblems(aliased, { $ref: "#/components/schemas/Alias" }, "")).toHaveLength(1);
});

it("documents audit timestamps so the response guard rejects tuple encoding", () => {
  expect(responseTimestampProblems(timestampContract, "/api/audit", "get", 200, { items: [{ occurred_at: [] }] })).toHaveLength(1);
});
it("documents readiness timestamps so the response guard rejects tuple encoding", () => {
  expect(responseTimestampProblems(timestampContract, "/api/v1/hr/readiness-summary", "get", 200, {
    imports: { latest_import_at: [] }, payroll: { latest_updated_at: [] },
  })).toHaveLength(2);
});

it.each(["operator_approved_at", "started_at", "ended_at"])("documents every support lifecycle timestamp: %s", (field) => {
  const check = (value: string | null) => responseTimestampProblems(timestampContract, "/api/v1/support-sessions", "get", 200, { sessions: [{ [field]: value }] });
  expect(check("2026-11-05T03:31:02.238349+00:00")).toHaveLength(1);
  expect(check("2026-11-05T03:31:02.238349Z")).toEqual([]);
  expect(check(null)).toEqual([]);
});

it.each([
  [{ type: "integer" }, 1],
  [{ type: "number" }, 1.5],
  [{ type: ["integer", "null"] }, 1],
])("accepts numeric alternatives alongside timestamps: %j", (numeric, value) => {
  const schema = { oneOf: [numeric, { $ref: "#/components/schemas/Instant" }] };
  expect(timestampProblems(spec, schema, value)).toEqual([]);
});

it("ignores unmatched alternatives that do not describe timestamps", () => {
  const schema = { oneOf: [{ type: "integer" }, { type: "string" }] };
  expect(timestampProblems(spec, schema, 1)).toEqual([]);
  expect(timestampProblems(spec, schema, [])).toEqual([]);
});

it("accepts numeric settings and pay-group values in the real response contracts", () => {
  expect(responseTimestampProblems(timestampContract, "/api/v1/settings", "get", 200, {
    items: [{ default: 1, value: 1 }],
  })).toEqual([]);
  expect(responseTimestampProblems(timestampContract, "/api/v1/settings/example.value", "post", 201, { value: 1 })).toEqual([]);
  expect(responseTimestampProblems(timestampContract, "/api/v1/payroll/pay-groups", "post", 201, {
    variable_period: { start_day: 1 },
  })).toEqual([]);
});

it("still rejects tuples and fractional numbers in nullable integer-or-timestamp alternatives", () => {
  const tuple = [2026, 309, 3, 31, 2, 238349000, 0, 0, 0];
  expect(responseTimestampProblems(spec, "/events", "get", 200, { entries: [{ maybe: tuple }] })).toHaveLength(1);
  const schema = { anyOf: [{ type: "integer" }, { $ref: "#/components/schemas/Instant" }, { type: "null" }] };
  expect(timestampProblems(spec, schema, 1.5)).toHaveLength(1);
});
