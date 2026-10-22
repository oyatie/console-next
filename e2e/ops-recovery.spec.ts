// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { PORTS } from "./slot";
import { apiAs } from "./chaos";
import type { Org, OpsRecoveryRead } from "../apps/web/src/features/platform/api";
import { expectAccessible } from "./a11y";
import { firstSignIn, go, takeCode, tenantSlugField, unique, vendorPage, vendorStepUp } from "./flows";
import { clearShifts, forgetResize, recordShifts } from "./stability";

async function selectTenant(page: Page, slug: string) {
  await go(page, "/platform");
  await page.getByRole("row").filter({ hasText: slug }).click();
  return page.getByRole("region", { name: "운영 계정(ops) 복구", exact: true });
}
async function openRecovery(page: Page, slug: string) {
  const section = await selectTenant(page, slug);
  await section.getByRole("button", { name: "운영 계정(ops) 복구 요청", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "운영 계정(ops) 복구 요청" });
  await expect(sheet).toContainText("알릴 수 있는 다른 계정이 없습니다");
  await sheet.getByRole("button", { name: "승인한 고객 담당자" }).click();
  await page.getByRole("option", { name: "대표자", exact: true }).click();
  await sheet.getByLabel("승인한 담당자 이름").fill("테스트 대표자");
  await sheet.getByLabel("본인 확인 방법 코드").fill("ORIGINAL_LEVEL_REPROOFING");
  await sheet.getByLabel("승인 기록 참조").fill("SYNTHETIC-TICKET-12345678");
  await vendorStepUp(async () => {
    await sheet.getByRole("button", { name: "운영 계정(ops) 복구 요청", exact: true }).click();
    await expect(sheet).toBeHidden();
  });
  await expect(section).toContainText("다른 운영자가 승인합니다");
  return section;
}

test("governed ops recovery: two operators, tenant veto, hold and once-only reenrollment", { tag: "@auth" }, async ({ browser, request }) => {
  const vendor = await vendorPage(browser);
  const readAsVendor = apiAs(vendor);
  const fixture = await request.post(`http://127.0.0.1:${PORTS.backend}/__e2e/ops-recovery/operator`, { data: { name: unique("복구 승인 운영자") } });
  expect(fixture.ok()).toBe(true);
  const second = await firstSignIn(browser, (await fixture.json()).otp);
  const slug = unique("ops-recovery");
  const company = unique("복구 고객");
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설", exact: true }).click();
  await vendor.getByLabel("고객 이름").fill(company);
  await tenantSlugField(vendor).fill(slug);
  await vendor.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const holder = await firstSignIn(browser, await takeCode(vendor));
  await vendor.reload();
  const first = await openRecovery(vendor, slug);
  await expectAccessible(vendor, "ops recovery vendor section");
  await second.reload();
  const approval = await selectTenant(second, slug);
  await approval.getByRole("button", { name: "복구 요청 승인", exact: true }).click();
  await expect(approval).toContainText("대기 종료");
  await expect(first).toContainText("대기 종료");
  await go(holder, "/account");
  const notice = holder.getByRole("region", { name: "운영 계정(ops) 복구", exact: true });
  await expect(notice).toContainText("대기 종료");
  await expect(notice).toContainText("공급사 운영자");
  await expect(notice).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  await expectAccessible(holder, "tenant recovery notice");
  await notice.getByRole("button", { name: "복구 요청 취소", exact: true }).click();
  const cancellation = holder.getByRole("dialog", { name: "복구 요청 취소" });
  await cancellation.getByLabel("취소 사유").fill("본인이 요청하지 않은 복구");
  await cancellation.getByRole("button", { name: "복구 요청 취소", exact: true }).click();
  await expect(notice).toContainText("본인이 요청하지 않은 복구");
  await expect(first).toContainText("본인이 요청하지 않은 복구");
  await vendor.reload();
  await selectTenant(vendor, slug);
  await expect(first).toContainText("본인이 요청하지 않은 복구");
  // A fresh request follows the same two-person ceremony, then the fixture advances only the hold clock.
  await vendor.reload();
  const cancelled = await selectTenant(vendor, slug);
  await cancelled.getByRole("button", { name: "운영 계정(ops) 복구 요청", exact: true }).click();
  const sheet = vendor.getByRole("dialog", { name: "운영 계정(ops) 복구 요청" });
  await sheet.getByRole("button", { name: "승인한 고객 담당자" }).click();
  await vendor.getByRole("option", { name: "대표자", exact: true }).click();
  await sheet.getByLabel("승인한 담당자 이름").fill("테스트 대표자");
  await sheet.getByLabel("본인 확인 방법 코드").fill("ORIGINAL_LEVEL_REPROOFING");
  await sheet.getByLabel("승인 기록 참조").fill("SYNTHETIC-SECOND-TICKET");
  await vendorStepUp(async () => { await sheet.getByRole("button", { name: "운영 계정(ops) 복구 요청", exact: true }).click(); await expect(sheet).toBeHidden(); });
  await second.reload();
  const secondApproval = await selectTenant(second, slug);
  await secondApproval.getByRole("button", { name: "복구 요청 승인", exact: true }).click();
  await expect(secondApproval).toContainText("대기 종료");
  const facts = await readAsVendor<Org[]>("/api/platform/orgs");
  const org = facts.find((o) => o.slug === slug)!;
  const read = await readAsVendor<OpsRecoveryRead>(`/api/platform/orgs/${org.id}/ops-recovery`);
  expect((await request.post(`http://127.0.0.1:${PORTS.backend}/__e2e/ops-recovery/elapse`, { data: { org_id: org.id, id: read.request!.id } })).ok()).toBe(true);
  await vendor.reload();
  const ready = await selectTenant(vendor, slug);
  const code = await vendorStepUp(async () => { await ready.getByRole("button", { name: "복구 코드 발급", exact: true }).click(); return takeCode(vendor, true); });
  const restored = await firstSignIn(browser, code, undefined, true);
  await expect(restored).toHaveURL(/\/$/);
  await restored.context().close();
  await holder.context().close();
  await second.context().close();
});

// regression (train fix r1): the panel drew its ops-recovery read late above 상태 and 삭제, so every tenant opened moved
// their buttons under a press already aimed at them (recovery.spec's tenant-panel check, red under load).
test("regression: a tenant's late ops-recovery read does not move the panel's 상태 and 삭제 controls", { tag: ["@auth", "@regression"] }, async ({ browser }) => {
  const vendor = await vendorPage(browser);
  const slug = unique("ops-panel");
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설", exact: true }).click();
  await vendor.getByLabel("고객 이름").fill(unique("패널 고객"));
  await tenantSlugField(vendor).fill(slug);
  await vendor.getByRole("button", { name: "개설하고 코드 발급" }).click();
  await takeCode(vendor);
  // A fresh load with no tenant chosen (onboarding opened this one's panel), so its recovery read is not cached.
  await vendor.goto("/platform");
  await expect(vendor.getByRole("row").filter({ hasText: slug })).toBeVisible();
  // The vendor page is shared by the worker's tests: tall enough that the sections stay in view (a block pushed off
  // screen reads as resized and only scores), a late read on purpose, and no shifts carried in from earlier tests.
  const size = vendor.viewportSize()!;
  const read = /\/api\/platform\/orgs\/[^/]+\/ops-recovery$/;
  await vendor.setViewportSize({ width: 1280, height: 1600 });
  await vendor.route(read, async (route) => { await new Promise((r) => setTimeout(r, 1_000)); await route.continue(); });
  try {
    await forgetResize(vendor);
    await vendor.evaluate(recordShifts);
    await vendor.evaluate(clearShifts);
    await vendor.getByRole("row").filter({ hasText: slug }).click();
    await expect(vendor.getByRole("region", { name: "운영 계정(ops) 복구", exact: true })).toBeVisible();
    await expectAccessible(vendor, "tenant panel after a late ops-recovery read");
  } finally {
    await vendor.unroute(read);
    await vendor.setViewportSize(size);
    await forgetResize(vendor);
  }
});
