// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { checklist as operatingChecklist, failure, id, inbox, LONG_NAME, screenAccess, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { previewData } from "../mock/onboarding";
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
    const preview = previewData("ready");
    const blockers = [
      { code: "no_legal_entity", remedy: "create_legal_entity", records: [] },
      { code: "no_workplace", remedy: "create_workplace", records: [] },
      { code: "terms_not_accepted", remedy: "accept_terms", records: [] },
      { code: "no_department", remedy: "add_department", records: [] },
      { code: "no_access_admin", remedy: "grant_access_admin", records: [] },
      { code: "no_org_change_approver", remedy: "invite_executive", records: [] },
      { code: "company_names_to_map", remedy: "map_company_names", records: [] },
    ];
    let previewReads = 0;
    await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", () => {
      previewReads++;
      return state === "preview-refused" ? { status: 403, json: failure("forbidden") } : { status: 200, json: { ...preview, blockers: blockers.slice(0, state === "blocked-7" ? 7 : state === "ready" ? 0 : 3) } };
    });
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
        const groups = checklist.steps.filter((s, i) => i === 0 || s.group !== checklist.steps[i - 1]!.group);
        await expect(rail.locator("ol")).toHaveCount(groups.length);
        await expect(rail.getByRole("heading", { level: 3 })).toHaveText(groups.map(s => t(`setup.group.${s.group}`)));
        const rows = rail.locator("[data-step]");
        await expect(rows).toHaveCount(checklist.steps.length);
        for (const [index, step] of checklist.steps.entries()) {
          await expect(rows.nth(index)).toContainText(t(`setup.step.${step.key}` as Parameters<typeof t>[0]));
          await expect(rows.nth(index).locator("[data-step-state]")).toBeVisible();
          if (!step.can_act) await expect(rows.nth(index)).toContainText(t("setup.permissionNeeded", { permission: t(`setup.permission.${step.needs}` as Parameters<typeof t>[0]) }));
          else if (await rows.nth(index).getAttribute("aria-current") === "step") await expect(rows.nth(index)).toContainText(step.can_act ? "담당 ·" : t("setup.permissionNeeded", { permission: t("setup.permission.tenant_ops") }));
          else await expect(rows.nth(index).locator("[data-step-owner]")).toHaveCount(0);
        }
        const progress = rail.getByRole("progressbar", { name: t("setup.title"), exact: true });
        await expect(progress).toHaveAttribute("aria-valuenow", String(checklist.done));
        await expect(progress).toHaveAttribute("aria-valuemax", String(checklist.total));
        await expect(main.locator("progress")).toHaveCount(0);
        const golive = checklist.steps.at(-1)!;
        const blockedCurrent = golive.state === "blocked" && checklist.steps.slice(0, -1).every(s => s.state === "done");
        await expect(rail.locator(".btn--primary")).toHaveCount(checklist.steps.find(s => s.state !== "done" && s.state !== "attention")?.can_act ? 1 : 0);
        if (blockedCurrent && golive.can_act) await expect(rail.locator('[aria-disabled="true"]')).toBeVisible();
        if (state === "blocked-3" || state === "blocked-7") {
          await expect(rail.locator("[data-setup-blocker]")).toHaveCount(state === "blocked-7" ? 5 : 3);
          if (state === "blocked-7") await expect(rail.getByRole("link", { name: "2건 더 보기" })).toHaveAttribute("href", "/setup/go-live");
        }
        if (state === "preview-unavailable" || state === "ready") expect(previewReads).toBe(0);
        if (state === "preview-refused") {
          await expect(rail.locator("[data-setup-blocker]")).toHaveCount(0);
          await expect(main.getByRole("alert")).toHaveCount(0);
          await expect(rail).toContainText("시작 전에 할 일 3건");
        }
        if (state === "first") {
          await expect(main.getByRole("alert")).toHaveCount(0);
          await expect(rail.locator(".chip--danger, .btn--danger")).toHaveCount(0);
        }
        for (const [index, step] of checklist.steps.entries()) {
          if (step.state === "blocked" && ["create_legal_entity", "create_workplace"].includes(step.remedy ?? "")) {
            await expect(rows.nth(index)).toContainText("대기 ·");
            await expect(rows.nth(index).getByRole("link")).toHaveCount(0);
          }
        }
        const history = rail.getByRole("link", { name: "설정 단계 기록", exact: true });
        if (checklist.steps.some(s => s.key === "org" && s.can_act)) await expect(history).toHaveAttribute("href", "/org/history");
        else await expect(history).toHaveCount(0);
        await expect(main.locator('#setup-bulk').locator("..").getByRole("link")).toHaveCount(0);
        if (state === "attention") {
          await expect(rows.nth(2)).toContainText("부서 없는 직원 3명");
          await expect(rows.nth(6)).toContainText("미배치 18");
          await expect(rows.nth(6).getByRole("link")).toHaveCount(1);
        }
        if (state === "long") await expect(main.getByText("2,000", { exact: true })).toBeVisible();
        if (state === "passkey") await expect(rail.locator('[aria-current="step"]')).toContainText("패스키 등록");
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `home-setup/${state}/${width}/${theme}`);
        await page.screenshot({ path: info.outputPath(`home-${width}-${theme}.png`), fullPage: true });
        await expectAxe(page, `home-setup/${state}/${width}/${theme}`);
        if (await rail.count()) {
          await rail.locator("[data-step]").last().scrollIntoViewIfNeeded();
          await page.screenshot({ path: info.outputPath(`home-${width}-${theme}-go-live.png`), fullPage: true });
          await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("main")?.scrollTo(0, 0); });
        }
      }
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
    json: { ...operatingChecklist, steps: homeSetupChecklist("ready").steps, phase: "OPERATING", go_live_at: startedAt, done: 9, total: 9 },
  });
  await mockRoute(page, "get", "/api/v1/onboarding/go-live/receipt", { status: 200, json: {
    go_live_at: startedAt, go_live_by: id(1), preview_digest: "a".repeat(64), facts_snapshot: { ...previewData("ready").facts, employees: 0 }, facts_snapshot_version: 1,
  } });
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(0) });
  try {
    await page.goto("/");
    const main = page.getByRole("main");
    await expect(main.getByRole("region", { name: /운영 준비|^시작$/ })).toHaveCount(0);
    await expect(main.locator("[data-setup-receipt]").getByRole("link", { name: "운영 시작 기록 보기", exact: true })).toHaveAttribute("href", "/setup/go-live");
    await expect(main.locator("[data-setup-receipt]").getByRole("link", { name: t("setup.bulk.history"), exact: true })).toHaveAttribute("href", "/org/history");
    await expect(main.locator("[data-setup-receipt]").getByText(t("setup.receipt.recorded"), { exact: false })).toBeVisible();
    await expect(main.locator("[data-setup-receipt]").getByRole("link", { name: t("setup.action.employees"), exact: true })).toHaveClass(/btn--primary/);
    await expect(main.locator("[data-setup-receipt]").getByRole("link", { name: t("setup.action.import"), exact: true })).toHaveAttribute("href", "/people/import");
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
