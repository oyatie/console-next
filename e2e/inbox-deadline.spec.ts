// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { go, kstDate } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { openUnit, sheet } from "./helpers/structure";
import { SETUP_DEPARTMENT, staffedTenant } from "./setup-flows";

test("the inbox uses the registered display window for a deadline beyond tomorrow", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "inboxdeadline", "신고기한회사");
  const bearer = bearerOf(admin);
  await go(admin, "/org");
  await admin.reload();
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  const settings = await api("/settings");
  expect(settings.status()).toBe(200);
  const { items } = await settings.json() as { items: { key: string; value: number; governance: string }[] };
  const window = items.find((item) => item.key === "display.deadline_due_soon_days");
  expect(window).toMatchObject({ governance: "read_only" });
  expect(window!.value).toBeGreaterThanOrEqual(3);

  const unit = await openUnit(admin, SETUP_DEPARTMENT);
  await unit.getByRole("button", { name: "이름 변경" }).click();
  const rename = sheet(admin, `${SETUP_DEPARTMENT} 이름 변경`);
  await rename.getByRole("textbox", { name: /^새 이름/ }).fill("기한확인팀");
  await rename.getByRole("textbox", { name: /^시행일/ }).fill(kstDate(3));
  await rename.getByRole("textbox", { name: /^사유/ }).fill("공유 표시 기한 확인");
  const saved = admin.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/org-changes");
  await rename.getByRole("button", { name: "부서 이름 변경 1개 예약" }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const change = await response.json() as { id: string };
  await expect(rename).toBeHidden();

  const queue = await api("/me/action-inbox?filter=scheduled");
  expect(queue.status()).toBe(200);
  const page = await queue.json() as components["schemas"]["ActionInboxResponse"];
  expect(page.items.find((item) => item.links.some((link) => link.kind === "org_change" && link.id === change.id)))
    .toMatchObject({ dueTone: "warn", days_remaining: 3 });
  await go(admin, "/");
  const inbox = admin.getByRole("region", { name: "업무함", exact: true });
  await inbox.getByRole("button", { name: /^예정 \d+\+?$/ }).click();
  await expect(inbox.locator(`a[href="/org/changes/${change.id}"]`)).toBeVisible();
});
