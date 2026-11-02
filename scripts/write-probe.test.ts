// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { probePath, attemptWrite } from "../e2e/authz/write-probe";

test("probe paths use fixture IDs for their own collection and fresh IDs elsewhere", () => {
  const entity = crypto.randomUUID(), employee = crypto.randomUUID();
  const ids = { "legal-entities": entity, employees: employee };
  expect(probePath("PATCH /api/v1/legal-entities/{id}", ids)).toBe(`/api/v1/legal-entities/${entity}`);
  expect(probePath("DELETE /api/v1/employees/{employee_id}/contacts/{id}", ids)).toMatch(new RegExp(`^/api/v1/employees/${employee}/contacts/[a-f0-9-]{36}$`));
  expect(probePath("POST null", ids)).toBeNull();
  expect(probePath("POST /unknown/{id}", ids)).not.toBe(probePath("POST /unknown/{id}", ids));
});

test("a transport failure remains unknown and does not stop the remaining operations", async () => {
  const result = await attemptWrite(async () => { throw new Error("transport with sensitive headers"); }, "/api/v1/example", "POST");
  expect(result).toEqual({ http_status: 0, code: null, support_ref: null, error: "request failed" });
  const invalid = await attemptWrite(async () => { throw new Error("must not send unresolved paths"); }, null, "POST");
  expect(invalid.http_status).toBe(0);
});

test("write attempts retain JSON refusal codes and tolerate non-JSON validation responses", async () => {
  const response = (http: number, body: object) => ({ status: () => http, ok: () => http < 400, json: async () => body, dispose: async () => {} });
  expect(await attemptWrite(async () => response(403, { error: { code: "missing_grant", support_ref: "synthetic" } }), "/api/v1/example", "PATCH"))
    .toEqual({ http_status: 403, code: "missing_grant", support_ref: "synthetic" });
  expect(await attemptWrite(async () => ({ ...response(422, {}), json: async () => { throw new Error("not JSON"); } }), "/api/v1/example", "POST"))
    .toEqual({ http_status: 422, code: null, support_ref: null });
});
