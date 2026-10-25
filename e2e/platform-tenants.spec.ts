// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { OTP_PATTERN } from "@console/api";
import type { components } from "@console/api/schema";
import { atPhoneWidth, expectAccessible } from "./a11y";
import { tenantOnboardSubmit, firstSignIn, go, takeCode, tenantSlugField, unique, vendorPage, vendorStepUp } from "./flows";
import { forgetResize } from "./stability";
import { PORTS } from "./slot";

type Opened = components["schemas"]["PlatformOrgOnboardingResponse"];

async function openTenant(page: Page, name: string, slug: string): Promise<Opened> {
  await go(page, "/platform");
  await forgetResize(page);
  await page.getByRole("button", { name: "고객 계정 개설", exact: true }).click();
  const form = page.getByRole("dialog", { name: "고객 계정 개설", exact: true });
  await form.getByLabel("고객 이름").fill(name);
  await tenantSlugField(form).fill(slug);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/platform/orgs" && r.request().method() === "POST");
  await tenantOnboardSubmit(page).click();
  const issued = await response;
  expect(issued.ok()).toBe(true);
  return issued.json();
}

test("tenant facts drive lifecycle, account counts and disabled deletion; first-admin handover is accessible", async ({ browser }) => {
  const vendor = await vendorPage(browser);
  const name = unique("전화로 안내할 고객");
  const slug = unique("plat-handover");
  const before = vendor.viewportSize();
  await vendor.setViewportSize({ width: 1440, height: 1000 });
  await forgetResize(vendor);
  const issued = await openTenant(vendor, name, slug);
  const dialog = vendor.getByRole("dialog", { name: "첫 관리자 로그인 코드" });
  await expect(dialog).toBeVisible();
  expect(issued.admin_sign_in_id).toBeTruthy();
  await expect(dialog.getByRole("group", { name: "아이디", exact: true })).toContainText(issued.admin_sign_in_id!);
  await expect(dialog.getByRole("button", { name: "아이디 복사" })).toBeVisible();
  const code = dialog.getByRole("group", { name: "일회용 코드", exact: true });
  await expect(code).toHaveText(new RegExp(OTP_PATTERN));
  await expect(dialog).toContainText("패스키를 등록하거나");
  await expect(dialog).toContainText("만료될 때까지 다시 쓸 수 있습니다");
  await expectAccessible(vendor, "platform code handover at 1440px");
  await atPhoneWidth(vendor, async () => {
    await expect(code).toBeVisible();
    await expectAccessible(vendor, "platform code handover at 390px");
  });
  const otp = await takeCode(vendor);

  await go(vendor, "/platform");
  await expect(vendor.getByRole("complementary", { name })).toHaveCount(0);
  const row = vendor.getByRole("row").filter({ hasText: slug });
  await expect(row).toContainText("코드 발급");
  await expect(row).not.toContainText("운영 중");
  await expect(row).toContainText("패스키 등록 0");
  await row.click();
  await expect(vendor.getByRole("complementary", { name })).toContainText("활성 0명");

  const listPath = "**/api/platform/orgs";
  await vendor.route(listPath, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const all = await response.json() as components["schemas"]["PlatformOrg"][];
    await route.fulfill({ response, json: all.map(org => org.id === issued.org.id
      ? { ...org, removable: false, removal_refusal: "tenant_has_data" } : org) });
  });
  let deletes = 0;
  const countDelete = (request: import("@playwright/test").Request) => {
    if (request.method() === "DELETE" && new URL(request.url()).pathname === `/api/platform/orgs/${issued.org.id}`) deletes++;
  };
  vendor.on("request", countDelete);
  try {
    await vendor.reload();
    const panel = vendor.getByRole("complementary", { name });
    const remove = panel.getByRole("button", { name: `${name} 삭제`, exact: true });
    await expect(remove).toHaveAttribute("aria-disabled", "true");
    await expect(remove).toHaveAccessibleDescription(`${name}에 운영 데이터가 있어 삭제할 수 없습니다. 보관할 수 있습니다.`);
    await remove.click({ force: true });
    await expect(vendor.getByRole("dialog")).toHaveCount(0);
    expect(deletes).toBe(0);
    await expect(panel.getByRole("button", { name: `${name} 보관`, exact: true })).toHaveCount(1);
  } finally {
    await vendor.unroute(listPath);
    vendor.off("request", countDelete);
    if (before) await vendor.setViewportSize(before);
    await forgetResize(vendor);
  }

  const admin = await firstSignIn(browser, otp);
  await go(admin, "/platform");
  await expect(admin.getByRole("heading", { name: "페이지를 찾을 수 없습니다" })).toBeVisible();
  await expect(admin.getByRole("heading", { name: "고객 계정", exact: true })).toHaveCount(0);
  await admin.context().close();
});

test("tenant erasure needs a second operator, waits through cooling and remains cancellable", async ({ browser, request }) => {
  const vendor = await vendorPage(browser);
  const name = unique("두 운영자가 확인할 고객");
  const slug = unique("plat-erase");
  const issued = await openTenant(vendor, name, slug);
  const erasePath = `/api/platform/orgs/${issued.org.id}/erase`;
  const servedFact = `**${erasePath}`;
  await vendor.route(servedFact, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), second_operator_available: false } });
  });
  await takeCode(vendor);
  let panel = vendor.getByRole("complementary", { name });
  await panel.getByRole("button", { name: `${name} 보관`, exact: true }).click();
  await vendor.getByRole("dialog").getByRole("button", { name: `${name} 보관`, exact: true }).click();
  const erase = panel.getByRole("button", { name: /모든 데이터 삭제$/, exact: false });
  await expect(erase).toHaveAttribute("aria-disabled", "true");
  await expect(erase).toHaveAccessibleDescription("패스키를 등록한 다른 운영자가 필요합니다.");
  await erase.focus();
  await erase.press("Enter");
  await expect(vendor.getByRole("dialog")).toHaveCount(0);
  await vendor.unroute(servedFact);

  const fixture = await request.post(`http://127.0.0.1:${PORTS.backend}/__e2e/ops-recovery/operator`, { data: { name: unique("삭제 승인 운영자") } });
  expect(fixture.ok()).toBe(true);
  const second = await firstSignIn(browser, (await fixture.json()).otp);
  await vendor.reload();
  panel = vendor.getByRole("complementary", { name });
  await panel.getByRole("button", { name: /모든 데이터 삭제$/ }).click();
  const form = vendor.getByRole("dialog", { name: "삭제 요청", exact: true });
  await expect(form).toContainText("다른 운영자가 승인한 뒤");
  await expect(form).toContainText("실행 전까지 취소할 수 있으며");
  await form.getByRole("textbox").fill(slug);
  const openedResponse = vendor.waitForResponse(r => new URL(r.url()).pathname === erasePath && r.request().method() === "POST");
  await vendorStepUp(async () => {
    await form.getByRole("button", { name: "삭제 요청", exact: true }).click();
    await expect(form).toBeHidden();
  });
  const opened = await openedResponse;
  expect(opened.ok()).toBe(true);
  const pending = await opened.json() as { id: string; cooling_until: string | null };
  expect(pending.cooling_until).toBeNull();
  const ownApproval = panel.getByRole("button", { name: "삭제 승인", exact: true });
  await expect(ownApproval).toHaveAttribute("aria-disabled", "true");
  await expect(ownApproval).toHaveAccessibleDescription("요청한 운영자는 승인할 수 없습니다. 다른 운영자에게 요청하십시오.");

  await go(second, `/platform?view=all&sel=${issued.org.id}`);
  const approval = second.getByRole("complementary", { name });
  const approvedResponse = second.waitForResponse(r => new URL(r.url()).pathname === `${erasePath}/${pending.id}/approve`);
  await approval.getByRole("button", { name: "삭제 승인", exact: true }).click();
  const approved = await approvedResponse;
  expect(approved.ok()).toBe(true);
  const cooling = await approved.json() as { cooling_until: string };
  expect(Date.parse(cooling.cooling_until)).toBeGreaterThan(Date.now());
  await expect(approval.getByRole("button", { name: "삭제 예약", exact: true })).toBeVisible();
  // The requester's already-open screen follows the stream; no reload or polling.
  await expect(panel.getByRole("button", { name: "삭제 예약", exact: true })).toBeVisible();
  await expect(panel).toContainText("이후 삭제됩니다. 실행 전까지 취소할 수 있습니다.");
  await expect(panel.getByRole("heading", { name, exact: true })).toBeVisible();
  const cancelledResponse = vendor.waitForResponse(r => new URL(r.url()).pathname === `${erasePath}/${pending.id}/cancel`);
  await vendorStepUp(async () => {
    await panel.getByRole("button", { name: "삭제 요청 취소", exact: true }).click();
    expect((await cancelledResponse).ok()).toBe(true);
  });
  await expect(panel.getByRole("button", { name: "삭제 예약", exact: true })).toHaveCount(0);
  await expect(approval.getByRole("button", { name: "삭제 예약", exact: true })).toHaveCount(0);
  await go(vendor, "/platform?view=all");
  await expect(vendor.getByRole("row").filter({ hasText: slug })).toContainText("보관됨");
  await second.context().close();
});
