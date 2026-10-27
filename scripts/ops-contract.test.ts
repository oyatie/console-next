// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const document = yaml.load(read("backend/openapi/ops.yaml")) as any;
const schemas = document.components.schemas;
const fixtures = JSON.parse(read("backend/crates/ops/rest/tests/fixtures/snapshots.json"));

// Test-only interpreter for the contract's JSON Schema vocabulary. Unknown keywords fail closed.
function accepts(schema: any, value: any): boolean {
  const supported = new Set(["$ref", "$schema", "$comment", "title", "description", "type", "required", "properties", "additionalProperties", "patternProperties", "minProperties", "uniqueItems", "allOf", "oneOf", "anyOf", "not", "enum", "const", "minimum", "minLength", "pattern", "format", "items", "discriminator"]);
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error(`untested schema keyword ${key}`);
  if (schema.$ref) return accepts(schemas[schema.$ref.split("/").at(-1)], value);
  if (schema.allOf && !schema.allOf.every((s: any) => accepts(s, value))) return false;
  if (schema.anyOf && !schema.anyOf.some((s: any) => accepts(s, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((s: any) => accepts(s, value)).length !== 1) return false;
  if (schema.not && accepts(schema.not, value)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if ("const" in schema && value !== schema.const) return false;
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && schema.type !== type && !(schema.type === "integer" && Number.isInteger(value))) return false;
  if (type === "number" && schema.minimum !== undefined && value < schema.minimum) return false;
  if (type === "string") {
    if (value.length < (schema.minLength ?? 0) || (schema.pattern && !new RegExp(schema.pattern, "u").test(value))) return false;
    if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value)))) return false;
    if (schema.format === "uuid" && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) return false;
    if (schema.format === "email" && !/^[^@\s]+@[^@\s]+$/.test(value)) return false;
    if (schema.format === "uri") { try { new URL(value); } catch { return false; } }
  }
  if (type === "array") {
    if (schema.items && !value.every((item: any) => accepts(schema.items, item))) return false;
    if (schema.uniqueItems && new Set(value.map((item: any) => JSON.stringify(item))).size !== value.length) return false;
  }
  if (type === "object") {
    if (Object.keys(value).length < (schema.minProperties ?? 0) || (schema.required ?? []).some((key: string) => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      const matched = Object.entries(schema.patternProperties ?? {}).filter(([pattern]) => new RegExp(pattern).test(key));
      if (matched.some(([, s]) => !accepts(s, item))) return false;
      if (Object.hasOwn(schema.properties ?? {}, key)) { if (!accepts(schema.properties[key], item)) return false; }
      else if (!matched.length && (schema.additionalProperties === false || (typeof schema.additionalProperties === "object" && !accepts(schema.additionalProperties, item)))) return false;
    }
  }
  return true;
}

const surfaces = { home: "HomeSnapshot", alerts: "AlertGroups", alert: "AlertDetail", running: "Running", jobs: "Jobs", sources: "Sources", silences: "Silences", me: "Me" };
test.each(Object.keys(fixtures))("%s snapshot obeys the contract and uses no placeholder values", (scenario) => {
  for (const [surface, schema] of Object.entries(surfaces)) {
    const body = fixtures[scenario][surface];
    expect(accepts(schemas[schema], body), `${scenario}/${surface}`).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"(?:No data|N\/A|—)"/u);
  }
});

test("envelopes reject missing observation times, wrong ladders and stale current values", () => {
  const observation = fixtures.healthy.running.components[0].health;
  const missing = structuredClone(observation);
  delete missing.observed_at;
  expect(accepts(schemas.ObservedHealth, missing)).toBe(false);
  expect(accepts(schemas.ObservedHealth, { ...observation, value: "Healty" })).toBe(false);
  expect(accepts(schemas.ObservedHealth, { ...observation, state: "Unknown", reason: "stale 3m" })).toBe(false);
  expect(accepts(schemas.ObservedHealth, { ...observation, state: "Unknown", value: null, reason: null })).toBe(false);
  for (const value of ["No data", "N/A", "—"]) expect(accepts(schemas.ObservedText, { ...observation, value })).toBe(false);
});

test("Timestamp's pattern itself requires UTC Z, independently of format validation", () => {
  const patternOnly = { type: "string", pattern: schemas.Timestamp.pattern };
  expect(accepts(patternOnly, "2026-01-01T00:00:00Z")).toBe(true);
  for (const time of ["2026-01-01T00:00:00+00:00", "2026-01-01T09:00:00+09:00", "2026-01-01T00:00:00"]) {
    expect(accepts(patternOnly, time), time).toBe(false);
  }
});

test("Canary is a closed state and its percentage is a numeric observation", () => {
  expect(schemas.Release.enum).toContain("Canary");
  expect(schemas.Release.enum).not.toContain("Canary n%");
  const weight = { ...fixtures.healthy.running.components[0].health, value: 25, unit: "%" };
  expect(accepts(schemas.Changing.properties.weight_percent, weight)).toBe(true);
  expect(accepts(schemas.Changing.properties.weight_percent, { ...weight, value: "25%" })).toBe(false);
});

test("all nine routes have JWT security, Cedar actions and no-store including refusals", () => {
  expect(Object.keys(document.paths)).toHaveLength(9);
  const refs = [...read("backend/openapi/ops.yaml").matchAll(/#\/components\/(\w+)\/([A-Za-z0-9._-]+)/g)];
  expect(refs.length).toBeGreaterThan(100);
  for (const [, section, name] of refs) expect(Object.hasOwn(document.components[section], name), name).toBe(true);
  for (const route of Object.values(document.paths) as any[]) {
    expect(Object.keys(route)).toEqual(["get"]);
    expect(route.get["x-cedar-action"]).toMatch(/^read\.(?:me|home|alerts|running|sources)$/);
    expect(route.get.security).toEqual([{ accessJwt: [] }]);
    expect(route.get.responses["200"].headers["Cache-Control"].schema.const).toBe("no-store");
    for (const code of ["401", "403"]) expect(route.get.responses[code].$ref).toMatch(/^#\/components\/responses\//);
  }
});

test.each(["OPS_ACCESS_JWT_MISSING", "OPS_ACCESS_JWT_INVALID", "OPS_ACCESS_AUD_MISMATCH", "OPS_NOT_OPERATOR", "OPS_GRANT_NOT_LIVE", "OPS_ACTION_DENIED", "OPS_CONFIG_INVALID", "origin_refused"])("refusal contract includes %s and requires a support reference", (code) => {
  const error = { evaluated_at: "2026-01-01T00:00:00Z", support_ref: "fixture-ref", code, message: "Refused" };
  expect(accepts(schemas.Error, error)).toBe(true);
  const missing = { ...error } as any;
  delete missing.support_ref;
  expect(accepts(schemas.Error, missing)).toBe(false);
  expect(accepts(schemas.Error, { ...error, code: "made_up" })).toBe(false);
});

test("Rust and OpenAPI ladders share the same closed vocabulary", () => {
  const source = read("backend/crates/ops/domain/src/ladders.rs");
  const matches = [...source.matchAll(/ladder!\((\w+)\s*\{([^}]+)\}\)/g)];
  expect(matches).toHaveLength(17);
  for (const [, name, variants] of matches) {
    const words = variants.split(",").map((v) => v.trim()).filter(Boolean).map((v) => v.includes("=") ? JSON.parse(v.split("=")[1].trim()) : v);
    expect(schemas[name].enum, name).toEqual(words);
  }
});

test("bundle schemas refuse missing intervals, plaintext emails, malformed dates and unknown sources", () => {
  const bundle = (name: string) => JSON.parse(read(`backend/crates/ops/domain/schemas/${name}.schema.json`));
  const components = { "console-1": { group: "app", host: "onprem-1", owner: "fixture", dashboard: "/running", runbook: "https://example.invalid/runbook", source: "victoriametrics", interval_s: 60 } };
  expect(accepts(bundle("components"), components)).toBe(true);
  const noInterval = structuredClone(components) as any;
  delete noInterval["console-1"].interval_s;
  expect(accepts(bundle("components"), noInterval)).toBe(false);
  const operator = { person: "00000000-0000-4000-8000-000000000001", email_sha256: "a".repeat(64), grants: [{ action: "read.home", from: "2026-01-01T00:00:00Z", until: "2027-01-01T00:00:00Z" }] };
  expect(accepts(bundle("operators"), [operator])).toBe(true);
  expect(accepts(bundle("operators"), [{ ...operator, email_sha256: "operator@example.invalid" }])).toBe(false);
  expect(accepts(bundle("operators"), [{ ...operator, email: "operator@example.invalid" }])).toBe(false);
  expect(accepts(bundle("operators"), [{ ...operator, grants: [{ ...operator.grants[0], until: "tomorrow" }] }])).toBe(false);
  const source = { url: "http://example.invalid", producer: "fixture", interval_s: 60 };
  const settings = { sources: { alertmanager: source, vmalert: source, victoriametrics: source }, access: { team: "fixture", aud: "fixture-aud", issuer: "https://example.invalid", jwks: "/fixture/jwks.json", interval_s: 60 }, origin: "https://example.invalid", thresholds: {}, budgets: {} };
  expect(accepts(bundle("ops-settings"), settings)).toBe(true);
  expect(accepts(bundle("ops-settings"), { ...settings, sources: { ...settings.sources, invented: source } })).toBe(false);
  expect(accepts(bundle("ops-settings"), { ...settings, origin: "https://example.invalid/path" })).toBe(false);
});

test("SSE payloads retain typed data and evaluated_at, with resync and heartbeat", () => {
  for (const event of schemas.Event.oneOf) {
    const type = event.properties.type.const;
    const frame: any = { type, id: 1, evaluated_at: fixtures.healthy.home.evaluated_at };
    const data = { home: fixtures.healthy.home, group: fixtures.healthy.alert.group, component: fixtures.healthy.running.components[0], job: fixtures.healthy.jobs.jobs[0], source: fixtures.healthy.sources.sources[0] } as any;
    for (const key of Object.keys(event.properties)) if (key in data) frame[key] = data[key];
    expect(accepts(schemas.Event, frame), type).toBe(true);
    expect(accepts(schemas.Event, { ...frame, id: 0 })).toBe(false);
    delete frame.evaluated_at;
    expect(accepts(schemas.Event, frame)).toBe(false);
  }
});
