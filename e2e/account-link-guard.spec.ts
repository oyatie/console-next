// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { inviteAccount } from "./access-flows";
import { apiAs } from "./chaos";
import { go } from "./flows";
import { fillRegister, openRegistered, pressRegister, receiptOf } from "./helpers/register";
import { tenantInSetup } from "./setup-flows";

test("employee account binding requires passkey and waits for a second person, including after reload", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "linkguard", "연결검증");
  await inviteAccount(admin, "연결대상", "none");
  const read = apiAs(admin);
  let authorization = "";
  admin.on("request", (request) => {
    if (request.url().includes("/api/v1/") && request.headers()["authorization"]) authorization = request.headers()["authorization"]!;
  });
  await go(admin, "/people/new");
  await fillRegister(admin, { name: "김연결", number: "K1-001", unit: "본점", hired: "2026-10-01" });
  await pressRegister(admin);
  await expect(receiptOf(admin, "김연결")).toBeVisible();
  await openRegistered(admin, "김연결", "K1-001");
  await admin.getByRole("navigation", { name: "인사카드 탭" }).getByRole("link", { name: "권한", exact: true }).click();
  const employeeId = new URL(admin.url()).pathname.split("/").pop()!;
  const directory = await read<{ items: { id: string }[] }>("/api/v1/directory/people?search=" + encodeURIComponent("연결대상"));
  const target = directory.items[0]!.id;
  const refused = await admin.request.patch(`/api/v1/users/${target}`, {
    headers: { authorization }, data: { employee_id: employeeId },
  });
  expect(refused.status()).toBe(428);
  expect((await refused.json()).error.code).toBe("step_up_required");
  const card = admin.getByRole("region", { name: "로그인 계정" });
  // Card is a labelled section (region); the passkey consequence precedes the command.
  await card.getByRole("combobox").fill("연결대상");
  await admin.getByRole("option", { name: /연결대상/ }).click();
  const requested = admin.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/v1/users/${target}`));
  await card.getByRole("button", { name: /패스키.*계정 연결/ }).click();
  const response = await requested;
  expect(response.status()).toBe(202);
  const pending = (await response.json()).account_link;
  expect(pending.status).toBe("PENDING");
  await expect(card).toContainText("확인 대기");
  await expect(card).toContainText(pending.requester_name);
  await expect(card).not.toContainText(pending.requested_by);
  await expect(card.getByRole("button", { name: /승인/ })).toHaveCount(0);
  expect((await read<{ employee_id: string | null }>(`/api/v1/users/${target}`)).employee_id).toBeNull();

  await admin.reload();
  await admin.getByRole("navigation", { name: "인사카드 탭" }).getByRole("link", { name: "권한", exact: true }).click();
  await card.getByRole("combobox").fill("연결대상");
  await admin.getByRole("option", { name: /연결대상/ }).click();
  const repeated = admin.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/v1/users/${target}`));
  await card.getByRole("button", { name: /패스키.*계정 연결/ }).click();
  expect((await (await repeated).json()).account_link.request_id).toBe(pending.request_id);
  await expect(card).toContainText("확인 대기");
  await expect(card).toContainText(pending.requester_name);
  await expect(card).not.toContainText(pending.requested_by);
  expect((await read<{ employee_id: string | null }>(`/api/v1/users/${target}`)).employee_id).toBeNull();
});
