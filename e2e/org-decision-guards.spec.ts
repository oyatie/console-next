// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type APIResponse } from "@playwright/test";
import { firstSignIn, go } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { setupCompany, startOperations } from "./setup-flows";
import { openTenant } from "./helpers/tenant";
import { revealUnit } from "./structure-flows";
import { inviteAccount } from "./access-flows";

type Schema = { $ref?: string; type?: string | string[]; required?: string[]; properties?: Record<string, Schema>; pattern?: string; minimum?: number; items?: Schema; oneOf?: Schema[]; enum?: unknown[]; format?: string };
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (source: string) => any };
const spec = yaml.load(readFileSync("backend/openapi/openapi.yaml", "utf8"));
const responseSchema = spec.paths["/api/v1/org-changes/{id}/approval-steps/{stepId}/decision"].post.responses["409"].content["application/json"].schema as Schema;
const conflict = responseSchema.$ref ? spec.components.schemas[responseSchema.$ref.split("/").at(-1)!] as Schema : responseSchema;

// Validate the emitted fields against the composed contract, including the legacy integer version.
function validates(schema: Schema, value: any): boolean {
  if (schema.$ref) return validates(schema.$ref.slice(2).split("/").reduce((node, key) => node[key], spec), value);
  if (schema.oneOf && schema.oneOf.filter(part => validates(part, value)).length !== 1) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !types.includes(type) && !(types.includes("integer") && Number.isInteger(value))) return false;
  if (type === "string" && schema.format === "date-time" && !Number.isFinite(Date.parse(value))) return false;
  if (type === "string" && schema.format === "uuid" && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (schema.minimum !== undefined && value < schema.minimum) return false;
  if (type === "array") return !schema.items || value.every((item: any) => validates(schema.items!, item));
  if (type === "object") {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => !schema.properties?.[key] || validates(schema.properties[key], item));
  }
  return true;
}

async function refusal(response: APIResponse, status: number, code: string) {
  expect([response.status(), await codeOf(response)]).toEqual([status, code]);
  const body = await response.json();
  expect(body.error).toMatchObject({ code, message: expect.any(String) });
  expect(validates(conflict, body)).toBe(true);
  return body;
}

test("decision conflict schema preserves required legacy fields and optional typed details", () => {
  expect(conflict.type).toBe("object");
  expect(conflict.required).toEqual(["error"]);
  const body = { error: { code: "lifecycle.refuse.stale_version", message: "stale", details: { current_version: "opaque" } } };
  expect(validates(conflict, body)).toBe(true);
  for (const invalid of [{}, { error: { code: "conflict" } }, { error: { ...body.error, current_version: "opaque" } }, { error: { ...body.error, details: { current_version: 1 } } }]) {
    expect(validates(conflict, invalid)).toBe(false);
  }
});

test("an org decision refuses missing grants, stale versions, merging, and a cancelled document without changing it", async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "decisionguards", "결재검증회사");
  const bearer = bearerOf(admin);
  await setupCompany(admin, "결재검증회사", "본점");
  await startOperations(admin);
  await go(admin, "/");
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  await go(admin, "/org");
  await revealUnit(admin, "본점");
  await admin.keyboard.press("a");
  const card = admin.getByRole("dialog", { name: "부서 신설", exact: true });
  await expect(card).toBeVisible();
  await card.getByLabel("부서 이름").fill("결재검증부");
  await card.getByRole("button", { name: /^오늘/ }).click();
  await card.getByLabel("사유").fill("결재 거절 검증");
  await card.getByRole("button", { name: "임시 저장" }).click();
  await expect(admin).toHaveURL(/\/org\/changes\/[0-9a-f-]+(?:\?|$)/);
  const id = new URL(admin.url()).pathname.split("/").at(-1)!;
  const read = async () => (await (await api(`/org-changes/${id}`)).json()) as { version: string; status: string };
  const before = await read();
  expect(before.version).toEqual(expect.any(String));
  const decision = `/org-changes/${id}/approval-steps/${crypto.randomUUID()}/decision`;
  for (const [extra, code] of [
    [{ expected_version: "stale" }, "lifecycle.refuse.stale_version"],
    [{ through_step: crypto.randomUUID() }, "lifecycle.refuse.merge_not_allowed"],
  ] as const) {
    const refused = await api(decision, "POST", { decision: "APPROVED", ...extra });
    const body = await refusal(refused, 409, code);
    if (code === "lifecycle.refuse.stale_version") expect(body.error.details.current_version).toBe(before.version);
    expect(await read()).toEqual(before);
  }
  const viewer = await firstSignIn(browser, await inviteAccount(admin, "결재 권한 없는 사용자", "none"));
  const viewerBearer = bearerOf(viewer);
  await viewer.reload();
  await expect.poll(viewerBearer).not.toBe("");
  const viewerApi = apiOf(viewer, viewerBearer);
  for (const choice of ["APPROVED", "REJECTED"]) {
    const refused = await viewerApi(decision, "POST", { decision: choice });
    await refusal(refused, 403, "org_change.refuse.missing_grant");
    expect(await read()).toEqual(before);
  }
  await viewer.context().close();
  await go(admin, `/org/changes/${id}`);
  await admin.getByRole("button", { name: "초안 취소", exact: true }).click();
  const cancel = admin.getByRole("dialog", { name: "초안 취소", exact: true });
  await cancel.getByLabel("취소 사유").fill("검증 완료");
  await cancel.getByRole("button", { name: /취소$/, exact: false }).last().click();
  await expect.poll(async () => (await read()).status).toBe("CANCELLED");
  const cancelled = await read();
  expect(cancelled.version).not.toBe(before.version);
  const refused = await api(decision, "POST", { decision: "APPROVED", expected_version: before.version });
  await refusal(refused, 409, "lifecycle.refuse.withdrawn");
  expect(await read()).toEqual(cancelled);
});
