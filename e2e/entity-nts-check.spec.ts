// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { LegalEntity } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import type { CheckAvailability, CheckHistory } from "../apps/web/src/features/entity/api";
import { atPhoneWidth, expectAccessible } from "./a11y";
import { apiAs } from "./chaos";
import { go, kstDate, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { registerEntity, REGISTRATION_FIXTURES } from "./setup-flows";
import { fillDate } from "./sheet";

test.beforeAll(() => loadCatalog("ko"));
const fakeUrl = process.env.NTS_FAKE_URL;
const card = (page: Page) => page.getByRole("region", { name: t("nts.title"), exact: true });
const pdf = (name: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF\n`) });

async function recordReissue(page: Page, name: string) {
  const sheet = page.getByRole("dialog", { name: "등록증 재발급·정정", exact: true });
  await sheet.locator('input[type="file"]').setInputFiles(pdf(name));
  await expect(sheet.getByRole("status")).toContainText(`첨부함 · ${name}`);
  await option(page, "발급 사유", "재발급 · 내용 그대로").click();
  await fillDate(sheet, kstDate(), "발급일");
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/v1\/business-registrations\/[^/]+\/reissues$/.test(new URL(response.url()).pathname));
  await sheet.getByRole("button", { name: "재발급·정정 기록", exact: true }).click();
  expect((await saved).ok(), "the original is attached to the recorded registration").toBe(true);
  await expect(sheet).toBeHidden();
}

test("a solo administrator checks NTS explicitly and a scheduled closed answer raises one mismatch", { tag: ["@org", "@nts"] }, async ({ browser, request }, info) => {
  test.skip(!fakeUrl, "Start node e2e/helpers/nts-fake.mjs, set NTS_FAKE_URL and NTS_BASE_URL to its loopback service, and provide a test-only NTS key before starting the backend.");
  const control = new URL("/__control", fakeUrl).href;
  expect((await request.post(control, { data: { status_code: "01", valid: "01", end_dt: "" } })).ok()).toBe(true);
  try {
    const page = await openTenant(browser, "nts-check", "국세청 확인 법인");
    const read = apiAs(page);
    await go(page, "/org/entities/new");
    const availability = await read<CheckAvailability>("/api/v1/registration-checks/availability");
    expect(availability.available, "the backend must use the configured loopback NTS fake").toBe(true);
    await registerEntity(page, "국세청 확인 법인");
    const recordPath = new URL(page.url()).pathname;
    const id = recordPath.split("/").at(-1)!;
    const entity = await read<LegalEntity>(`/api/v1/legal-entities/${id}`);
    const registration = entity.registrations[0]!;
    const path = `/api/v1/business-registrations/${registration.id}/checks`;

    const status = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === path);
    await card(page).getByRole("button", { name: t("nts.action.status"), exact: true }).click();
    expect((await status).status()).toBe(200);
    await expect(card(page).getByText(t("enum.verification.T1"), { exact: true })).toBeVisible();
    await expect(card(page)).toContainText(t("nts.result.continuing"));
    await expect(card(page)).toContainText("KST");

    await card(page).getByRole("button", { name: t("nts.action.validate"), exact: true }).click();
    const consent = page.getByRole("dialog", { name: t("nts.validate.title"), exact: true });
    for (const value of [REGISTRATION_FIXTURES.primary.brn, "20200302", "홍길동", t("nts.validate.purpose")]) await expect(consent).toContainText(value);
    await expectAccessible(page, "NTS explicit validation consent");
    const validated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === path);
    await consent.getByRole("button", { name: t("nts.validate.send"), exact: true }).click();
    expect((await validated).status()).toBe(200);
    await expect(consent).toBeHidden();
    await expect(card(page).getByText(t("enum.verification.T2"), { exact: true })).toBeVisible();

    const before = await read<CheckHistory>(path);
    const previous = new Set(before.items.map((check) => check.id));
    expect((await request.post(control, { data: { status_code: "03", end_dt: "20261001", valid: "01" } })).ok()).toBe(true);
    // Reissue makes the registration due immediately; the production worker performs the next status-only check.
    await page.getByRole("button", { name: /등록증 재발급·정정$/ }).first().click();
    await recordReissue(page, "상태조회-재발급.pdf");
    await expect.poll(async () => (await read<CheckHistory>(path)).items.some((check) => !previous.has(check.id) && check.trigger === "SCHEDULE" && check.kind === "STATUS" && check.status_code === "03"), { timeout: info.timeout, message: "the scheduled NTS worker must append the due status check" }).toBe(true);
    const after = await read<CheckHistory>(path);
    const checked = after.latest_status!;
    expect(checked.recorded_status_mismatch).toBe(true);
    expect(checked.inbox_item_id).toBeTruthy();
    expect((await read<LegalEntity>(`/api/v1/legal-entities/${id}`)).registrations[0]!.current?.status).toBe("CONTINUING");
    await page.reload();
    await expect(card(page).getByText(t("enum.verification.T2"), { exact: true })).toBeVisible();
    await expect(card(page)).toContainText(t("nts.mismatch"));
    await expect(card(page)).toContainText("2026. 10. 01.");
    await expect(card(page).getByRole("link", { name: t("nts.inbox"), exact: true })).toHaveAttribute("href", `/#nts-${checked.inbox_item_id}`);
    const repeated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === path);
    await card(page).getByRole("button", { name: t("nts.action.status"), exact: true }).click();
    expect((await repeated).status()).toBe(200);
    expect((await read<CheckHistory>(path)).latest_status?.inbox_item_id).toBe(checked.inbox_item_id);
    await expectAccessible(page, "NTS mismatch desktop");
    await atPhoneWidth(page, () => expectAccessible(page, "NTS mismatch phone"));
    await go(page, "/");
    const inboxLink = page.getByRole("link", { name: t("nts.inbox.review"), exact: true });
    await expect(inboxLink).toHaveAttribute("href", `${recordPath}?nts=${registration.id}`);
    await expect(page.locator(`[id="nts-${checked.inbox_item_id}"]`)).toContainText("국세청 확인 법인");
    await inboxLink.click();
    await expect(card(page)).toContainText(t("nts.mismatch"));
    expect((await request.post(control, { data: { status_code: "01", end_dt: "", valid: "01" } })).ok()).toBe(true);
    const agreement = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === path);
    await card(page).getByRole("button", { name: t("nts.action.status"), exact: true }).click();
    expect((await agreement).status()).toBe(200);
    await expect(card(page).getByText(t("nts.mismatch"), { exact: true })).toHaveCount(0);
    await go(page, "/");
    await expect(inboxLink).toHaveCount(0);

  } finally {
    await request.post(control, { data: { status_code: "01", valid: "01", end_dt: "" } });
  }
});

test("without a configured key the administrator sees the reason and attaches the original", { tag: ["@org", "@nts"] }, async ({ browser }) => {
  const page = await openTenant(browser, "nts-no-key", "국세청 수동 증빙 법인");
  const read = apiAs(page);
  await go(page, "/org/entities/new");
  const availability = await read<CheckAvailability>("/api/v1/registration-checks/availability");
  test.skip(availability.available || availability.reason !== "NOT_CONFIGURED", "Run this test against a backend started without NTS_BUSINESSMAN_API_KEY and its expiry setting.");
  await registerEntity(page, "국세청 수동 증빙 법인");
  await expect(card(page)).toContainText(t("nts.state.unavailable"));
  await expect(card(page)).toContainText(t("nts.unavailable.NOT_CONFIGURED"));
  await expect(card(page)).toContainText(t("nts.fallback"));
  await expect(card(page).getByRole("button", { name: t("nts.action.status"), exact: true })).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: t("nts.action.validate"), exact: true })).toHaveCount(0);
  await expect(card(page).getByText(t("enum.verification.T2"), { exact: true })).toHaveCount(0);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const entity = await read<LegalEntity>(`/api/v1/legal-entities/${id}`);
  const registration = entity.registrations[0]!;
  const historyPath = `/api/v1/business-registrations/${registration.id}/revisions`;
  const before = await read(historyPath);
  await card(page).getByRole("button", { name: t("nts.attach"), exact: true }).click();
  const sheet = page.getByRole("dialog", { name: t("nts.attach"), exact: true });
  await expect(sheet.getByLabel("발급일", { exact: true })).toHaveCount(0);
  await expect(sheet.getByText("발급 사유", { exact: true })).toHaveCount(0);
  await sheet.locator('input[type="file"]').setInputFiles(pdf("국세청-수동-증빙.pdf"));
  await expect(sheet.getByRole("status")).toContainText("첨부함 · 국세청-수동-증빙.pdf");
  const attached = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/business-registrations/${registration.id}/original`);
  await sheet.getByRole("button", { name: t("nts.attach"), exact: true }).click();
  expect((await attached).status()).toBe(200);
  await expect(sheet).toBeHidden();
  expect(await read(historyPath), "attaching evidence must create no revision or reissue").toEqual(before);
  expect((await read<LegalEntity>(`/api/v1/legal-entities/${id}`)).registrations[0]!.current).toEqual(registration.current);
  await page.getByRole("button", { name: /^문서 1/ }).click();
  await expect(page.getByRole("row", { name: /국세청-수동-증빙\.pdf/ })).toContainText("사용 중");
  await expectAccessible(page, "NTS unavailable original attached");
});
