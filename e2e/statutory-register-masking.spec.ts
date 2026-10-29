// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go, kstDate, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";

test("the worker register never returns a clear personal phone by default", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "register-masking", "명부확인회사");
  await registerEmployee(admin, { name: "김명부", number: "MASK-1", hired: kstDate(-1) });
  await go(admin, "/statutory?tab=register");
  await admin.getByRole("button", { name: /사업장/ }).click();
  const read = admin.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/statutory/worker-register");
  await admin.getByRole("option", { name: /본사/ }).click();
  const response = await read;
  expect(response.ok()).toBe(true);
  const page = await response.json();
  const row = page.items.find((r: { cells: string[] }) => r.cells[0] === "MASK-1");
  expect(row.cells[5]).toBe("010-••••-0001");
  expect(JSON.stringify(page)).not.toContain("12340001");
  const table = admin.getByRole("table", { name: "근로자 명부" });
  await expect(table.getByRole("row").filter({ hasText: "MASK-1" })).toContainText("010-••••-0001");
  await expect(table).not.toContainText("010-1234-0001");
});
