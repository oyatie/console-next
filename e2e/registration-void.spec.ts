// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { inviteAccount } from "./access-flows";
import { expectAccessible } from "./a11y";
import { firstSignIn, go, option } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { registerEntity, setupCompany } from "./setup-flows";

const previewPath = /\/api\/v1\/business-registrations\/[0-9a-f-]{36}\/end-options$/;
const voidPath = /\/api\/v1\/business-registrations\/[0-9a-f-]{36}\/void$/;
const sheet = (page: Page) => page.getByRole("dialog", { name: "사업자등록증 삭제", exact: true });
const confirm = (page: Page) => sheet(page).getByRole("button", { name: "사업자등록증 삭제", exact: true });

async function openVoid(page: Page) {
  await page.getByRole("button", { name: /^사업자등록증(?: · 본점)? 더보기$/ }).click();
  await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
  await expect(sheet(page)).toBeVisible();
}

// Mounted menu → preview → reason → the served command. Worlds are created through the UI; failed or stale reads are injected, commands use the backend.
test("certificate void fails closed during preview loading/failure and rechecks permission before submitting", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const admin = await openTenant(browser, "reg-void", "새온그룹");
  const api = apiOf(admin, bearerOf(admin));
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "새온정밀");
  const record = new URL(admin.url()).pathname;
  const entity = await (await api(`/legal-entities/${record.split("/").pop()!}`)).json();
  const id = entity.registrations[0].id as string;
  const writes: string[] = [];
  admin.on("request", (r) => { if (r.method() === "POST" && voidPath.test(new URL(r.url()).pathname)) writes.push(r.url()); });

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await admin.route(previewPath, async (route) => {
    await held;
    await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "preview unavailable" } } });
  });
  await openVoid(admin);
  await option(admin, "삭제 사유", "중복 등록").click();
  await expect(confirm(admin)).toBeDisabled();
  release();
  await expect(sheet(admin).getByRole("button", { name: "삭제 미리보기 다시 읽기" })).toBeVisible();
  await expect(confirm(admin)).toBeDisabled();
  expect(writes).toEqual([]);

  // A revoked grant can arrive after the card was read; the mounted dialog must honor it after a reason is chosen.
  await admin.unroute(previewPath);
  await admin.route(previewPath, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), can_manage: false } });
  });
  await sheet(admin).getByRole("button", { name: "삭제 미리보기 다시 읽기" }).click();
  await expect(sheet(admin)).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
  await expect(confirm(admin)).toBeDisabled();
  expect(writes).toEqual([]);
  await sheet(admin).getByRole("button", { name: "돌아가기", exact: true }).click();
  await admin.unroute(previewPath);

  const preview = admin.waitForResponse((r) => previewPath.test(new URL(r.url()).pathname));
  await openVoid(admin);
  expect((await preview).status()).toBe(200);
  await expect(sheet(admin)).toContainText("개정 이력 1건");
  await expect(confirm(admin)).toBeDisabled();
  await option(admin, "삭제 사유", "중복 등록").click();
  await expect(confirm(admin)).toBeEnabled();
  await expectAccessible(admin, "registration void preview and reason");
  const removed = admin.waitForResponse((r) => r.request().method() === "POST" && voidPath.test(new URL(r.url()).pathname));
  await confirm(admin).click();
  const response = await removed;
  expect(response.status()).toBe(204);
  expect(new URL(response.url()).pathname).toBe(`/api/v1/business-registrations/${id}/void`);
  expect(response.request().postDataJSON()).toEqual({ reason_code: "DUPLICATE" });
  expect(response.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  await expect(sheet(admin)).toBeHidden();
  await admin.reload();
  expect((await (await api(`/legal-entities/${entity.id}`)).json()).registrations).toEqual([]);
  expect(writes).toHaveLength(1);
});

test("a linked workplace refuses registration void after reason selection and at the server without changing the record", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const admin = await openTenant(browser, "reg-in-use", "새온그룹");
  const api = apiOf(admin, bearerOf(admin));
  await setupCompany(admin, "새온정밀", "본사");
  const entityId = new URL(admin.url()).pathname.split("/").pop()!;
  const before = await (await api(`/legal-entities/${entityId}`)).json();
  const id = before.registrations[0].id as string;
  const preview = admin.waitForResponse((r) => previewPath.test(new URL(r.url()).pathname));
  await openVoid(admin);
  const end = await (await preview).json();
  expect(end.delete).toEqual({ allowed: false, refusal: "record_in_use" });
  expect(end.linked_workplaces).toContainEqual({ id: before.workplaces[0].id, name: "본사" });
  await expect(sheet(admin)).toContainText("본사");
  await option(admin, "삭제 사유", "시험 입력").click();
  await expect(confirm(admin)).toBeDisabled();
  const denied = await api(`/business-registrations/${id}/void`, "POST", { reason_code: "TEST_ENTRY" }, { "Idempotency-Key": crypto.randomUUID() });
  expect(denied.status()).toBe(409);
  expect(await codeOf(denied)).toBe("record_in_use");
  expect((await (await api(`/legal-entities/${entityId}`)).json()).registrations).toEqual(before.registrations);

  // A stale allowed preview cannot bypass the command's current workplace check.
  await sheet(admin).getByRole("button", { name: "돌아가기", exact: true }).click();
  await admin.route(previewPath, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), delete: { allowed: true }, linked_workplaces: [] } });
  });
  await openVoid(admin);
  await option(admin, "삭제 사유", "시험 입력").click();
  await expect(confirm(admin)).toBeEnabled();
  const refused = admin.waitForResponse((r) => r.request().method() === "POST" && voidPath.test(new URL(r.url()).pathname));
  await confirm(admin).click();
  expect((await refused).status()).toBe(409);
  await expect(sheet(admin).getByRole("alert")).toContainText("이 기록을 쓰는 곳이 있어 삭제할 수 없습니다");
  await expect(sheet(admin)).toBeVisible();
  expect((await (await api(`/legal-entities/${entityId}`)).json()).registrations).toEqual(before.registrations);
});

test("a reader with no legal-entity management grant cannot open or submit registration void", { tag: ["@org", "@access", "@regression"] }, async ({ browser }) => {
  const admin = await openTenant(browser, "reg-no-grant", "새온그룹");
  const adminApi = apiOf(admin, bearerOf(admin));
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "새온정밀");
  const record = new URL(admin.url()).pathname;
  const entityId = record.split("/").pop()!;
  const before = await (await adminApi(`/legal-entities/${entityId}`)).json();
  const id = before.registrations[0].id as string;
  const code = await inviteAccount(admin, "김조회", "oversight");
  const reader = await firstSignIn(browser, code);
  const api = apiOf(reader, bearerOf(reader));
  await go(reader, record);
  await expect(reader.getByRole("heading", { name: /새온정밀/, level: 1 })).toBeVisible();
  await expect(reader.getByRole("button", { name: /^사업자등록증.* 더보기$/ })).toHaveCount(0);
  const end = await api(`/business-registrations/${id}/end-options`);
  expect(end.status()).toBe(200);
  expect((await end.json()).can_manage).toBe(false);
  const denied = await api(`/business-registrations/${id}/void`, "POST", { reason_code: "DUPLICATE" }, { "Idempotency-Key": crypto.randomUUID() });
  expect(denied.status()).toBe(403);
  expect(await codeOf(denied)).toBe("forbidden");
  expect((await (await adminApi(`/legal-entities/${entityId}`)).json()).registrations).toEqual(before.registrations);
});
