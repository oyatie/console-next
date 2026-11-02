// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { classifyWrite, probeWrites } from "../e2e/authz/write-probe";

const result = (http_status: number, code: string | null = "synthetic_refusal") => ({ http_status, code, support_ref: null });
const response = (http: number) => ({ status: () => http, ok: () => http < 400, json: async () => ({ error: { code: "synthetic_refusal" } }), dispose: async () => {} });
async function probe(operations: string[], ids: Record<string, string>, send: Parameters<typeof probeWrites>[2]) {
  const rows = [];
  for await (const row of probeWrites(operations, ids, send, async () => response(204))) rows.push(row);
  return rows;
}

test.each([200, 201, 204])("accepted protected write %s is red regardless of control", http => {
  expect(classifyWrite(result(http), result(403))).toMatchObject({ status: "fail", fault: "accepted without a grant" });
});

test.each([0, 302, 400, 404, 409, 422, 429, 500])("response %s remains unknown", http => {
  expect(classifyWrite(result(http), result(200))).toMatchObject({ status: "unknown", fault: null });
});

test("a refused write needs a valid ops control and a refusal code", () => {
  for (const http of [200, 204, 400, 404, 409, 422]) expect(classifyWrite(result(403), result(http))).toEqual({ status: "pass", controlValid: true, fault: null });
  for (const http of [0, 302, 401, 403, 500]) expect(classifyWrite(result(403), result(http))).toMatchObject({ status: "unknown", controlValid: false });
  for (const code of [null, "", "  "]) expect(classifyWrite(result(403, code), result(200)).status).toBe("unknown");
  expect(classifyWrite(result(401), result(200))).toMatchObject({ status: "unknown", fault: "unauthenticated probe" });
});

test("self-service never proves protected access and its exceptions only shrink", () => {
  for (const http of [200, 401, 422]) expect(classifyWrite(result(http), result(200), "Own session")).toMatchObject({ status: "unknown", fault: null });
  expect(classifyWrite(result(403), result(200), "Own session")).toMatchObject({ status: "unknown", fault: "remove self-service exception (synthetic_refusal)" });
});

test("all no-grant writes run before destructive ops controls with identical paths", async () => {
  const operations = ["DELETE /api/v1/employees/{id}", "PATCH /api/v1/employees/{id}", "POST /api/v1/unknown/{id}"];
  const calls: string[] = [], recorded: string[] = [];
  let fixtureExists = true;
  const rows = probeWrites(operations, { employees: "synthetic-employee" }, async (path, method) => {
    calls.push(`no-grant ${method} ${path}`);
    return response(fixtureExists ? 403 : 404);
  }, async (path, method) => {
    calls.push(`ops ${method} ${path}`);
    if (method === "DELETE") fixtureExists = false;
    return response(204);
  });
  for await (const { operation, result: measured, control } of rows) {
    expect(measured.http_status).toBe(403);
    expect(control.http_status).toBe(204);
    recorded.push(operation);
  }
  expect(recorded).toEqual(operations);
  expect(calls.slice(0, operations.length).every(call => call.startsWith("no-grant "))).toBe(true);
  expect(calls.slice(operations.length)).toEqual(calls.slice(0, operations.length).map(call => call.replace("no-grant ", "ops ")));
});

test("the probe spec uses the tested sweep and classifier", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../e2e/authz/write-refusals.spec.ts", import.meta.url), "utf8");
  expect(source).toMatch(/for await \(const .* of probeWrites\(/);
  expect(source).toContain("classifyWrite(result, control, self_service_reason)");
  expect(source).not.toContain("await attemptWrite(");
});

test("probe paths use fixture IDs for their own collection and fresh IDs elsewhere", async () => {
  const entity = crypto.randomUUID(), employee = crypto.randomUUID();
  const ids = { "legal-entities": entity, employees: employee };
  const rows = await probe(["PATCH /api/v1/legal-entities/{id}", "DELETE /api/v1/employees/{employee_id}/contacts/{id}", "POST null", "POST /unknown/{id}", "POST /unknown/{id}"], ids, async () => response(403));
  expect(rows[0].path).toBe(`/api/v1/legal-entities/${entity}`);
  expect(rows[1].path).toMatch(new RegExp(`^/api/v1/employees/${employee}/contacts/[a-f0-9-]{36}$`));
  expect(rows[2].path).toBeNull();
  expect(rows[3].path).not.toBe(rows[4].path);
});

test("a transport failure remains unknown and does not stop the remaining operations", async () => {
  const [failed, invalid, next] = await probe(["POST /api/v1/example", "POST null", "PATCH /api/v1/example"], {}, async (_path, method) => {
    if (method === "POST") throw new Error("transport with sensitive headers");
    return response(403);
  });
  expect(failed.result).toEqual({ http_status: 0, code: null, support_ref: null, error: "request failed" });
  expect(invalid.result).toEqual({ http_status: 0, code: null, support_ref: null, error: "unresolved route" });
  expect(next.result.http_status).toBe(403);
});

test("write attempts retain JSON refusal codes and tolerate non-JSON validation responses", async () => {
  const response = (http: number, body: object) => ({ status: () => http, ok: () => http < 400, json: async () => body, dispose: async () => {} });
  const [refused] = await probe(["PATCH /api/v1/example"], {}, async () => response(403, { error: { code: "missing_grant", support_ref: "synthetic" } }));
  expect(refused.result)
    .toEqual({ http_status: 403, code: "missing_grant", support_ref: "synthetic" });
  const [invalid] = await probe(["POST /api/v1/example"], {}, async () => ({ ...response(422, {}), json: async () => { throw new Error("not JSON"); } }));
  expect(invalid.result)
    .toEqual({ http_status: 422, code: null, support_ref: null });
});
