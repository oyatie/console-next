// SPDX-License-Identifier: LicenseRef-Proprietary
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { go, registerEmployee } from "./flows";
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

test("an open request screen renders future request kinds and subjects", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "relrequest", "요청호환검증회사");
  const request = {
    id: randomUUID(), kind: "FUTURE_KIND", subject_type: "FUTURE_SUBJECT", subject_id: randomUUID(),
    payload: {}, reason_code: "review", requested_by: randomUUID(), assignee_role: "HR",
    status: "OPEN", review_required: false, created_at: new Date().toISOString(),
  };
  await admin.route("**/api/v1/change-requests?*", (route) => route.fulfill({
    json: { items: [request], total: 1, offset: 0, limit: 20 },
  }));
  await go(admin, "/people/requests");
  const row = admin.getByRole("row").filter({ hasText: "FUTURE_KIND" });
  await expect(row).toContainText("FUTURE_SUBJECT");
  await row.getByRole("button").click();
  const panel = admin.getByRole("complementary", { name: "요청 상세", exact: true });
  await expect(panel).toContainText("FUTURE_KIND");
  await expect(panel).toContainText("FUTURE_SUBJECT");
});
