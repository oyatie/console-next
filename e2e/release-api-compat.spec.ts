// SPDX-License-Identifier: LicenseRef-Proprietary
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { registerEmployee } from "./flows";
import { openHistory } from "./record";
import { staffedTenant } from "./setup-flows";

test("an open personnel screen can read a future release's leave type", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "relapi", "호환성검증회사");
  await admin.route("**/api/v1/employees/*/lifecycle-events*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    expect(body.items.length).toBeGreaterThan(0);
    body.items.push({ ...body.items[0], id: randomUUID(), event_type: "LEAVE_OF_ABSENCE", leave_type: "FUTURE_LEAVE" });
    await route.fulfill({ response, json: body });
  });
  await registerEmployee(admin, { name: "호환검증", number: "REL-0001" });
  await openHistory(admin);
  const history = admin.getByRole("region", { name: "인사 이력" });
  await expect(history).toContainText("확인되지 않은 항목");
  await expect(history.locator(".chip--neutral", { hasText: "FUTURE_LEAVE" })).toBeVisible();
});
