// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { checklist as operatingChecklist, failure, id, inbox, LONG_NAME, screenAccess, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { homeSetupCases, homeSetupChecklist, homeSetupScreen } from "./home-setup";

test.beforeAll(() => loadCatalog("ko"));
for (const { state, registry } of homeSetupCases) for (const width of [1440, 390]) {
  test(`home setup: ${state} at ${width}px @ui-state`, async ({ page }, info) => {
    info.annotations.push({ type: "registry", description: registry });
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, homeSetupScreen, ["loading", "failed", "refused"].includes(state) ? state as "loading" | "failed" | "refused" : "empty");
    const checklist = homeSetupChecklist(state);
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: checklist });
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: { tenant_name: state === "long" ? LONG_NAME : "검증법인", phase: "SETUP", unplaced: [], entities: [] } });
    if (!["loading", "failed", "refused"].includes(state)) {
      await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(0), setup: checklist } });
    }
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto("/");
      const main = page.getByRole("main");
      const rail = main.getByRole("region", { name: t("setup.title"), exact: true });
      if (state === "loading") {
        await expect(main.locator('[aria-busy="true"]').last()).toBeVisible({ timeout: 20_000 });
        await expect(rail).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText("불러오지 못했습니다", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("button", { name: "다시 불러오기", exact: true }).first()).toBeVisible();
        await expect(main.getByText(failure("service_unavailable").error.operation_id!, { exact: true }).first()).toBeVisible();
        await expect(rail).toHaveCount(0);
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
        await expect(rail).toHaveCount(0);
      } else {
        await expect(rail).toBeVisible({ timeout: 20_000 });
        await expect(rail.getByRole("list")).toHaveCount(1);
        await expect(rail.getByRole("heading", { level: 3 })).toHaveCount(0);
        const rows = rail.locator("[data-step]");
        await expect(rows).toHaveCount(checklist.steps.length);
        for (const [index, step] of checklist.steps.entries()) {
          await expect(rows.nth(index)).toContainText(t(`setup.step.${step.key}` as Parameters<typeof t>[0]));
          await expect(rows.nth(index).locator("[data-step-state]")).toBeVisible();
          await expect(rows.nth(index)).toContainText("담당 ·");
        }
        const progress = rail.getByRole("progressbar", { name: t("setup.title"), exact: true });
        await expect(progress).toHaveAttribute("aria-valuenow", String(checklist.done));
        await expect(progress).toHaveAttribute("aria-valuemax", String(checklist.total));
        await expect(main.locator("progress")).toHaveCount(0);
        await expect(rail.locator(".btn--primary")).toHaveCount(state === "mid" ? 0 : 1);
        if (state !== "mid") await expect(rail.locator('[aria-current="step"] .btn--primary')).toHaveCount(1);
        for (const [index, step] of checklist.steps.entries()) {
          if (step.state === "blocked" && ["create_legal_entity", "create_workplace"].includes(step.remedy ?? "")) {
            await expect(rows.nth(index)).toContainText("대기 ·");
            await expect(rows.nth(index).locator("a,button")).toHaveCount(0);
          }
        }
        await expect(rail.getByRole("link", { name: "설정 단계 기록", exact: true })).toHaveAttribute("href", "/org/history");
        await expect(main.locator('#setup-bulk').locator("..").getByRole("link")).toHaveCount(0);
        if (state === "long") await expect(main.getByText("2,000", { exact: true })).toBeVisible();
        if (state === "passkey") await expect(rail.locator('[aria-current="step"]')).toContainText("패스키 등록");
      }
      await fits(page, `home-setup/${state}/${width}`);
      await expectAxe(page, `home-setup/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}

for (const width of [1440, 390]) test(`setup rail gallery at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, homeSetupScreen, "empty");
  await page.goto("/_gallery");
  if (width === 390) {
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  const rail = page.getByRole("region", { name: "운영 준비", exact: true });
  await rail.scrollIntoViewIfNeeded();
  await expect(rail.getByRole("heading", { level: 3 })).toHaveCount(3);
  await expect(rail.getByRole("progressbar", { name: "운영 준비", exact: true })).toHaveAttribute("aria-valuenow", "2");
  await expect(rail.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "7");
  expect(await rail.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});

for (const width of [1440, 390]) test(`home post-go-live receipt link at ${width}px @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, homeSetupScreen, "empty");
  const startedAt = new Date().toISOString();
  await mockRoute(page, "get", "/api/v1/users/me", {
    status: 200,
    json: { ...user, is_tenant_ops: true, tenant: { name: "화면 검증 회사", phase: "OPERATING", go_live_at: startedAt } },
  });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/", "OPERATING"), is_ops: true } });
  await mockRoute(page, "get", "/api/v1/settings", {
    status: 200,
    json: {
      can_change: false,
      items: [{
        key: "onboarding.receipt_days", kind: { type: "int", unit: "days" }, default: 7, value: 7,
        looser_when: "neutral", governance: "tenant", legal_basis: null, version: "code_default",
        effective_from: null, scheduled: [], source: { layer: "code_default", scope_entity_id: null }, chain: [],
      }],
    },
  });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", {
    status: 200,
    json: { ...operatingChecklist, phase: "OPERATING", go_live_at: startedAt, done: 8, total: 8 },
  });
  await mockRoute(page, "get", "/api/v1/onboarding/go-live/receipt", { status: 200, json: {
    go_live_at: startedAt, go_live_by: id(1), preview_digest: "a".repeat(64), facts_snapshot: null, facts_snapshot_version: 1,
  } });
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(0) });
  try {
    await page.goto("/");
    const main = page.getByRole("main");
    await expect(main.getByRole("region", { name: /운영 준비|^시작$/ })).toHaveCount(0);
    await expect(main.locator("[data-setup-receipt]").getByRole("link", { name: "운영 시작 기록 보기", exact: true })).toHaveAttribute("href", "/setup/go-live");
    await expect(main.locator("[data-setup-receipt]").getByRole("link", { name: t("setup.bulk.history"), exact: true })).toHaveAttribute("href", "/org/history");
    await expect(main.locator("[data-setup-receipt]").getByText(t("setup.receipt.unrecorded"), { exact: true })).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await fits(page, `home-setup/receipt/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`home-${width}-${theme}.png`), fullPage: true });
      await expectAxe(page, `home-setup/receipt/${width}/${theme}`);
    }
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});
