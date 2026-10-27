// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { orgPanelReads, orgWorkReads } from "../mock/org-work";
import { id } from "../mock/fixtures";
import { fmtDate } from "@console/i18n/format";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { orgWorkScreens, type OrgWorkState } from "./org-work";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of orgWorkScreens) for (const state of Object.keys(screen.states) as OrgWorkState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const shell = await mockScreen(page, screens[2], state === "operating" ? "populated" : state);
    const fixture = { ...shell, ...await orgWorkReads(page, state) };
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main");
      const heading = main.getByRole("heading", { level: 1 });
      await expect(heading).toHaveCount(1);
      await expect(heading).toBeVisible();
      if (screen.key !== "org-move") await expect(heading).toHaveText(t(screen.title));
      if (state === "loading") {
        await expect(main.locator("[data-read-layout]")).toBeVisible();
      } else if (state === "failed") {
        await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toHaveCount(1, { timeout: 20_000 });
        await expect(main.getByText(fixture.operationId, { exact: true })).toBeVisible();
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeEnabled();
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
        await expect(main.locator("textarea, input[type=file]")).toHaveCount(0);
      } else if (screen.key === "org-paste") {
        if (state === "operating") {
          await expect(main.locator("textarea")).toHaveCount(0);
          await expect(main.locator("#plan-title, #paste-foot")).toHaveCount(0);
          await expect(main.getByRole("link", { name: t("orgBulk.operating.action") })).toHaveAttribute("href", `/org?sel=${fixture.workplaceId}&act=dept-add`);
        } else if (state === "empty") {
          await expect(main.getByRole("link", { name: t("entity.empty.action"), exact: true })).toHaveAttribute("href", "/org/entities/new");
        } else {
          await expect(main.getByRole("textbox", { name: t("orgBulk.paste.input") })).toBeVisible();
        }
      } else if (screen.key === "org-import") {
        await expect(main.getByRole("button", { name: t("uiFileDrop.pick"), exact: true })).toBeVisible();
      } else if (state === "empty") {
        await expect(main.getByText(t("bulkMove.nothing"), { exact: true })).toBeVisible();
      } else {
        await expect(heading).toHaveText(t("bulkMove.titleOne", { name: "검증부서 1" }));
        await expect(main.getByRole("heading", { name: t("bulkMove.what"), exact: true })).toBeVisible();
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

for (const width of [1440, 390]) {
  test(`org: panel and sheet copy at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[2], "populated");
    const { dept } = await orgPanelReads(page);
    await page.goto(`/org?sel=${dept.id}`);
    const panel = page.getByRole("complementary", { name: dept.name, exact: true });
    await expect(panel.getByRole("button", { name: "직원 1", exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "직속 직원 1", exact: true })).toBeVisible();
    await expect(panel.locator("#dept-actions [aria-describedby]")).toHaveCount(0);
    await expect(panel.getByText("하위 부서와 구성원을 넘기고 폐지합니다", { exact: true })).toHaveCount(0);
    await fits(page, `department panel/${width}`);
    await expectAxe(page, `department panel/${width}`);
    await panel.getByRole("button", { name: "부서 폐지", exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: "폐지 전 지정", exact: true })).toBeVisible();
    await expect(sheet.getByText("전보 대상 1명 · 본사 직속", { exact: true })).toBeVisible();
    await expect(sheet.getByText(/운영 중이라 조직 변경으로/)).toHaveCount(0);
    await sheet.getByRole("button", { name: "갈 곳 변경", exact: true }).click();
    await expect(sheet.getByRole("treegrid")).toBeVisible();
    await fits(page, `dissolve sheet/${width}`);
    await expectAxe(page, `dissolve sheet/${width}`);
    await sheet.getByRole("button", { name: t("uiSheet.close"), exact: true }).click();
    await page.goto(`/org?sel=${dept.id}&act=dept-add`);
    await sheet.getByRole("textbox", { name: /^부서 이름/ }).fill("새부서");
    await sheet.getByRole("textbox", { name: /^시행일/ }).fill("2099-11-01");
    await sheet.getByRole("textbox", { name: /^사유/ }).fill("조직 운영 개선");
    await expect(sheet.getByText(t("orgUnit.gov.addConsequence", { name: "새부서", date: fmtDate("2099-11-01") }), { exact: true })).toBeVisible();
    await expect(sheet.getByText(/설정 단계였다면/)).toHaveCount(0);
    await fits(page, `department creation/${width}`);
    await expectAxe(page, `department creation/${width}`);
    await page.goto(`/org?sel=${id(4)}`);
    const workplace = page.getByRole("complementary", { name: "본사", exact: true });
    await expect(workplace.getByText("적지 않음", { exact: true })).toHaveCount(0);
    await expect(workplace.getByRole("region", { name: "기본", exact: true }).getByText("—", { exact: true }).first()).toBeVisible();
    await fits(page, `workplace panel/${width}`);
    await expectAxe(page, `workplace panel/${width}`);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`org: blocked end has only a change link at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[2], "populated");
    const { dept, change } = await orgPanelReads(page, true);
    await page.goto(`/org?sel=${dept.id}`);
    const panel = page.getByRole("complementary", { name: dept.name, exact: true });
    await expect(panel.getByText(`${change.code} 진행 중`, { exact: true })).toBeVisible();
    await expect(panel.getByRole("link", { name: `${change.code} 열기`, exact: true })).toHaveAttribute("href", `/org/changes/${change.id}`);
    await expect(panel.locator("#act-dept-delete")).toHaveCount(0);
    await fits(page, `blocked department/${width}`);
    await expectAxe(page, `blocked department/${width}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("org: pending end reason appears on keyboard focus and hover @ui-state", async ({ page }) => {
  await mockScreen(page, screens[2], "populated");
  const fixture = await orgPanelReads(page, false, true);
  try {
    await page.goto(`/org?sel=${fixture.dept.id}`);
    const control = page.locator("#act-dept-delete");
    await expect(control).toHaveAttribute("aria-disabled", "true");
    const reason = page.locator(`[id='${await control.getAttribute("aria-describedby")}']`);
    await expect(reason).toBeHidden();
    await control.focus();
    await expect(reason).toBeVisible();
    await control.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await control.press("Tab");
    await expect(reason).toBeHidden();
    await control.hover();
    await expect(reason).toBeVisible();
  } finally {
    await page.close();
    fixture.release();
  }
});
