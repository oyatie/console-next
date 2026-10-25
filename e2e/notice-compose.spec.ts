// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible } from "./a11y";
import { go, koDate, kstDate, registerEmployee } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { reasonChip } from "./helpers/lifecycle";
import { fillDate, reasonBox, sheet, signOff, todayPreset } from "./sheet";
import { staffedTenant } from "./setup-flows";
import { forgetResize } from "./stability";

async function scheduleTransfer(admin: Page, name: string, number: string, date: string) {
  await registerEmployee(admin, { name, number, unit: "인사부", hired: kstDate(-60) });
  const person = new URL(admin.url()).pathname;
  const employeeId = person.split("/").at(-1)!;
  await go(admin, `${person}?act=TRANSFER`);
  const transfer = sheet(admin, "전보");
  await expect(transfer).toBeVisible();
  await transfer.getByRole("combobox", { name: "어디로" }).fill("채용팀");
  await admin.getByRole("option", { name: /채용팀/ }).click();
  await fillDate(transfer, date);
  await reasonChip(transfer, "조직 개편").click();
  await reasonBox(transfer).fill("공고 작성 검증");
  await signOff(transfer);
  const recorded = admin.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/v1/employees/${employeeId}/lifecycle-events`);
  await transfer.getByRole("button", { name: /^전보 1명 예약/ }).click();
  const response = await recorded;
  expect(response.ok()).toBe(true);
  const event = await response.json() as { id: string; state: string };
  expect(event.state).toBe("SCHEDULED");
  await expect(transfer).toBeHidden();
  return { employeeId, eventId: event.id };
}

test("a notice starts from its list, excludes announced events and refuses a stale pick", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await staffedTenant(browser, "noticepick", "공고작성점검");
  const api = apiOf(admin, bearerOf(admin));
  const date = kstDate(7);
  await scheduleTransfer(admin, "표진우", "NOTICE-001", date);
  const stale = await scheduleTransfer(admin, "전하윤", "NOTICE-002", kstDate(8));
  await admin.setViewportSize({ width: 1440, height: 1000 });
  await forgetResize(admin);
  await go(admin, "/people/notices");
  await admin.getByRole("link", { name: "공고 작성", exact: true }).click();
  await expect(admin.getByRole("heading", { name: "발령 공고", level: 1 })).toBeVisible();
  const first = admin.getByRole("checkbox", { name: /^표진우 · 전보/ });
  await expect(admin.getByRole("region", { name: koDate(date), exact: true }).getByRole("checkbox", { name: /^표진우 · 전보/ })).toBeVisible();
  await expect(admin.getByRole("button", { name: /^공고 작성/ })).toHaveCount(0);
  await first.check();
  await expect(admin.getByRole("table", { name: "공고 미리보기" }).getByRole("row", { name: /표진우/ })).toContainText("채용팀");
  await todayPreset(admin).click();
  await expectAccessible(admin, "notice compose: selected event and live preview");
  await atPhoneWidth(admin, () => expectAccessible(admin, "notice compose: selected event and live preview at phone width"));
  const issued = admin.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/v1/appointment-notices");
  await admin.getByRole("button", { name: /^공고 작성/ }).click();
  const response = await issued;
  expect(response.status()).toBe(201);
  const notice = await response.json() as { id: string; notice_no: string };
  await expect(admin).toHaveURL(new RegExp(`/people/notices/${notice.id}$`));
  await expect(admin.getByRole("article", { name: new RegExp(`인사발령 제${notice.notice_no}호`) })).toBeVisible();

  await go(admin, "/people/notices/new");
  const second = admin.getByRole("checkbox", { name: /^전하윤 · 전보/ });
  await expect(second).toBeVisible();
  await expect(first).toHaveCount(0);
  await second.check();
  await todayPreset(admin).click();
  const cancelled = await api(`/employees/${stale.employeeId}/lifecycle-events/${stale.eventId}/cancel`, "POST", { reason: "예약 철회" });
  expect(cancelled.status()).toBe(200);
  const refused = admin.waitForResponse((result) => result.request().method() === "POST"
    && new URL(result.url()).pathname === "/api/v1/appointment-notices");
  await admin.getByRole("button", { name: /^공고 작성/ }).click();
  const refusal = await refused;
  expect([refusal.status(), await codeOf(refusal)]).toEqual([409, "appointment_notice_event_ineligible"]);
  await expect(admin.getByRole("alert")).toContainText("취소되거나 철회된 발령은 공고에 포함하지 않습니다");
  const notices = await api("/appointment-notices");
  expect((await notices.json() as { items: unknown[] }).items).toHaveLength(1);
});
