// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { authz, id, LONG_NAME } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { mockRoute } from "../mock/route";
import { orgChange } from "../mock/org-changes";
import { orgChangeScreens, type OrgChangeState, type State } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of orgChangeScreens) for (const state of Object.keys(screen.states) as (State | OrgChangeState)[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await mockScreen(page, screen, state);
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main");
      if (state === "loading") {
        await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
        await expect(main.locator("[data-read-layout]").last()).toHaveAttribute("data-read-layout", screen.key === "org-changes" ? "list" : "record");
        await expect(main.getByText(t("orgChange.list.empty.all"), { exact: true })).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeEnabled();
        await expect(main.getByText(fixture.operationId, { exact: true })).toBeVisible();
      } else if (state === "refused") {
        const refusal = main.getByRole("region", { name: t("common.denied.title.plain") });
        await expect(refusal).toBeVisible();
        await expect(refusal).toContainText("김권한담당");
        await expect(refusal.getByRole("button", { name: t("common.denied.request"), exact: true })).toBeEnabled();
      } else if (state === "missing") {
        await expect(main.getByRole("heading", { name: t("common.read.notFound.title") })).toBeVisible();
        await expect(main.getByRole("link", { name: t("orgChange.list.title"), exact: true })).toHaveAttribute("href", "/org/changes");
      } else if (state === "empty") {
        await expect(main.getByRole("heading", { name: t("orgChange.list.empty.all") })).toBeVisible();
        await expect(main.getByRole("link", { name: t("orgChange.list.empty.action") })).toHaveAttribute("href", "/org");
      } else if (screen.key === "org-changes") {
        const table = main.getByRole("table", { name: t("orgChange.list.title") });
        await expect(table.getByRole("link", { name: "OC-2026-0001", exact: true })).toBeVisible();
        await expect(table.locator("tbody > tr")).toHaveCount(Math.min(fixture.count, 50));
        if (state === "long") await expect(table).toContainText(LONG_NAME.repeat(3));
        if (state === "large") {
          await main.getByRole("button", { name: t("common.page.next"), exact: true }).click();
          await expect(table.getByRole("link", { name: "OC-2026-0051", exact: true })).toBeVisible();
          await expect(table.locator("tbody > tr")).toHaveCount(50);
          await main.getByRole("button", { name: t("common.page.prev"), exact: true }).click();
          await expect(table.getByRole("link", { name: "OC-2026-0001", exact: true })).toBeVisible();
        }
      } else {
        const record = orgChange(state);
        await expect(main.getByRole("heading", { level: 1 })).toHaveText(t("orgChange.title.create", { name: state === "long" ? LONG_NAME.repeat(3) : "검증부서 1" }));
        await expect(main.locator("header")).toContainText(t(`enum.orgChangeStatus.${record.status}`));
        await expect(main.getByRole("region", { name: t("orgChange.proposal"), exact: true })).toContainText(state === "long" ? LONG_NAME.repeat(8) : "조직 운영 개선");
        const history = main.getByRole("complementary", { name: t("orgChange.history"), exact: true });
        await expect(history.getByRole("listitem")).toHaveCount(Math.min(record.events.length, 50));
        if (state === "large") {
          const pager = history.getByRole("navigation", { name: t("common.page.label"), exact: true });
          await expect(pager).toContainText(t("common.page.range", { from: 1, to: 50, total: record.events.length }));
          await pager.getByRole("button", { name: t("common.page.next"), exact: true }).click();
          await expect(pager).toContainText(t("common.page.range", { from: 51, to: 100, total: record.events.length }));
          await expect(history.getByRole("listitem")).toHaveCount(50);
          await pager.getByRole("button", { name: t("common.page.prev"), exact: true }).click();
          await expect(pager).toContainText(t("common.page.range", { from: 1, to: 50, total: record.events.length }));
        }
        if (state === "draft" || state === "prechecked") await expect(main.getByRole("region", { name: "사전 점검", exact: true })).toContainText("통과");
        if (state === "approval") await expect(main.getByRole("region", { name: t("orgChange.next.title") })).toContainText(t("orgChange.turn", { role: "인사" }));
        if (state === "rejected") await expect(main).toContainText("시행일을 다시 검토해 주십시오");
        if (state === "settling") await expect(main).toContainText("직책 정리");
      }
      await fits(page, `${screen.key}/${state}/${width}`);
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected, "register every supporting read").toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}

test("saved views use server filters and keep phone cards linked to their record @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const screen = orgChangeScreens[0];
  const fixture = await mockScreen(page, screen, "populated");
  try {
    await page.goto(screen.path);
    const main = page.getByRole("main");
    const views = main.getByRole("group", { name: t("orgChange.list.views") });
    const table = main.getByRole("table", { name: t("orgChange.list.title") });
    for (const [view, count] of [["open", 2], ["ready", 1], ["done", 1], ["mine", 2]] as const) {
      const pick = views.getByRole("button", { name: t(`orgChange.list.view.${view}`, { count: fmtNumber(count) }), exact: true });
      await pick.click();
      await expect(pick).toHaveAttribute("aria-pressed", "true");
      await expect(table.locator("tbody > tr")).toHaveCount(count);
    }
    const code = table.getByRole("link", { name: "OC-2026-0001", exact: true });
    await code.focus();
    await expect(code).toBeFocused();
    await code.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${orgChangeScreens[1].path}$`));
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(t("orgChange.title.create", { name: "검증부서 1" }));
    await fits(page, "org-change/linked/390");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

for (const state of ["applied", "approval", "draft", "rejected"] as const) for (const width of [1440, 390]) {
  test(`org-change: ${state} without a note labels its reason at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-11-04T12:00:00+09:00"));
    const screen = orgChangeScreens[1];
    const fixtureState = state === "applied" ? "populated" : state;
    const fixture = await mockScreen(page, screen, fixtureState);
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities, ...["org_change_draft", "org_change_approve"].map(feature => ({ feature, permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false }))] } });
    let record = { ...orgChange(fixtureState), kind: "NEW" as const, reason: "NEW", effectiveDate: "2026-11-20", ...(state === "approval" ? { draftedBy: id(5) } : {}) };
    await page.route(`**/api/v1/org-changes/${record.id}`, async route => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON();
        expect(body.reason ?? record.reason).toBe("NEW");
        record = { ...record, ...body, updatedAt: "2026-11-04T12:00:00Z" };
      }
      await route.fulfill({ json: record });
    });
    await page.route(`**/api/v1/org-changes/${record.id}/preflight`, route => route.fulfill({ json: record }));
    const writes: unknown[] = [];
    await page.route("**/api/v1/org-changes", route => {
      if (route.request().method() !== "POST") return route.fallback();
      writes.push(route.request().postDataJSON());
      return route.fulfill({ status: 422, json: { error: { code: "invalid_change", message: "Change refused" } } });
    });
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main");
      const reason = state === "approval" ? main.locator("blockquote").first() : main.getByRole("region", { name: t("orgChange.proposal"), exact: true }).locator("dd").first();
      await expect(reason).toHaveText(t("orgUnit.gov.reasonNew"));
      await expect(main.getByText("NEW", { exact: true })).toHaveCount(0);
      if (state === "draft" || state === "rejected") {
        await main.getByRole("button", { name: t(state === "draft" ? "orgChange.edit" : "orgChange.redraft"), exact: true }).click();
        const dialog = page.getByRole("dialog");
        const note = dialog.getByRole("textbox", { name: new RegExp(`^${t("orgChange.reason")}`) });
        await expect(note).toHaveValue("");
        await expect(note).not.toHaveAttribute("aria-required", "true");
        for (const theme of ["light", "dark"]) {
          await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
          await fits(page, `${state}/note/${width}/${theme}`);
          await expectAxe(page, `${state}/note/${width}/${theme}`);
        }
        await dialog.getByRole("button", { name: new RegExp(`^${t("orgChange.date.nextMonth")}`) }).click();
        if (state === "draft") {
          await dialog.getByRole("button", { name: commitLabel({ kind: "orgChange", mode: "change" }), exact: true }).click();
          await expect(dialog).toHaveCount(0);
          expect(record.reason).toBe("NEW");
          expect(record.effectiveDate).toBe("2026-12-01");
        } else {
          await dialog.getByRole("button", { name: t("composer.saveDraft"), exact: true }).click();
          await expect.poll(() => writes.length).toBe(1);
          expect(writes).toEqual([expect.objectContaining({ kind: "NEW", reason: "NEW", supersedesId: record.id })]);
        }
      } else for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `${state}/reason/${width}/${theme}`);
        await expectAxe(page, `${state}/reason/${width}/${theme}`);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
