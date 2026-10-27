// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "../mock/screen";
import { failure } from "../mock/fixtures";
import { moveDetail, unplacedTarget } from "../mock/lifecycle-sheets";
import { mockRoute } from "../mock/route";
import { lifecycleSheetScreens } from "./lifecycle-sheets";

for (const width of [1440, 390]) {
  for (const state of [403, 503, "loading"] as const) {
    test(`unknown move placement ${state} at ${width}px @ui-state`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const screen = lifecycleSheetScreens[0];
      const fixture = await mockScreen(page, screen, "populated");
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let structureReads = 0;
      if (state === "loading") {
        await page.route(url => url.pathname === "/api/v1/org-structure", async route => {
          structureReads++;
          await held;
          await route.fulfill({ status: 503, json: failure("service_unavailable") });
        });
      } else {
        await mockRoute(page, "get", "/api/v1/org-structure", { status: state, json: failure(state === 403 ? "forbidden" : "service_unavailable") });
      }
      const previews: string[] = [], writes: string[] = [];
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname === "/api/v1/lifecycle-case-templates/TRANSFER") previews.push(request.url());
        if (request.method() === "POST" && url.pathname.includes("/lifecycle-events")) writes.push(request.url());
      });
      await page.goto(screen.path);
      if (state === "loading") {
        await expect(page.getByRole("heading", { name: /배치직원/, level: 1 })).toBeVisible();
        await expect.poll(() => structureReads).toBe(1);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(previews).toEqual([]);
        release();
      }
      const sheet = page.getByRole("dialog");
      await expect(sheet).toHaveAccessibleName("발령");
      const picker = sheet.getByRole("combobox", { name: "어디로", exact: true });
      await picker.fill("재무팀");
      await page.getByRole("option", { name: /재무팀/ }).click();
      await sheet.getByRole("button", { name: /^오늘 / }).click();
      await sheet.getByRole("textbox", { name: /^사유/ }).fill("사업장 이동 검토");
      await expect(sheet).toHaveAccessibleName("발령");
      await expect(sheet).not.toContainText(/전보|전근/);
      const commit = sheet.getByRole("button", { name: "발령 1명 반영", exact: true });
      await expect(commit).toHaveAttribute("aria-disabled", "true");
      await expect(commit).toHaveAccessibleDescription("현재 배치와 이동할 사업장을 확인해야 기록할 수 있습니다.");
      await commit.focus();
      await page.keyboard.press("Enter");
      await sheet.locator("form").evaluate(form => (form as HTMLFormElement).requestSubmit());
      await fits(page, `unknown-move/${state}/${width}`);
      await expectAxe(page, `unknown-move/${state}/${width}`);
      expect(previews).toEqual([]);
      expect(writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }

  for (const state of ["null-workplace", "unplaced-target"] as const) {
    test(`known move placement ${state} at ${width}px @ui-state`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const screen = lifecycleSheetScreens[0];
      const fixture = await mockScreen(page, screen, "populated");
      if (state === "null-workplace") {
        await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 200, json: { ...moveDetail, employee: { ...moveDetail.employee, workplace_id: null } } });
      } else {
        await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: unplacedTarget.structure });
        await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [unplacedTarget.entity] } });
      }
      const variants: (string | null)[] = [];
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname === "/api/v1/lifecycle-case-templates/TRANSFER") variants.push(url.searchParams.get("variant"));
      });
      await page.goto(screen.path);
      const sheet = page.getByRole("dialog");
      const picker = sheet.getByRole("combobox", { name: "어디로", exact: true });
      await picker.fill("재무팀");
      await page.getByRole("option", { name: /재무팀/ }).click();
      await sheet.getByRole("button", { name: /^오늘 / }).click();
      await sheet.getByRole("textbox", { name: /^사유/ }).fill("배치 검토");
      await expect(sheet).toHaveAccessibleName("전보");
      await expect(sheet.getByRole("button", { name: "전보 1명 반영", exact: true })).toBeEnabled();
      await expect(sheet).not.toContainText("전근");
      const siteRow = sheet.getByRole("table", { name: "바뀌는 것" }).locator('[data-id="site"]');
      await expect(siteRow).toHaveText(state === "unplaced-target" ? "사업장본사→ —" : "사업장—→ 부산사업장");
      await expect.poll(() => variants.length).toBeGreaterThan(0);
      expect(variants).not.toContain("WORKPLACE_CHANGE");
      await fits(page, `known-move/${state}/${width}`);
      await expectAxe(page, `known-move/${state}/${width}`);
      expect(fixture.unexpected).toEqual([]);
    });
  }

  test(`move origin and derived kind at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = lifecycleSheetScreens[0];
    const fixture = await mockScreen(page, screen, "populated");
    const variants: (string | null)[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/lifecycle-case-templates/TRANSFER") variants.push(url.searchParams.get("variant"));
    });
    await page.goto(screen.path);
    const sheet = page.getByRole("dialog", { name: "전보", exact: true });
    const picker = sheet.getByRole("combobox", { name: "어디로", exact: true });
    await picker.fill("인사팀");
    await page.getByRole("option", { name: /인사팀/ }).click();
    const changes = page.getByRole("table", { name: "바뀌는 것" });
    await expect(changes.locator('[data-id="unit"]')).toContainText("사업장 직속");
    await expect(changes.locator('[data-id="unit"]')).toContainText("→ 인사팀");
    await expect(changes.locator('[data-id="site"]')).toHaveText("사업장본사→ 본사");
    await expect(sheet.getByRole("button", { name: "전보 1명 예약", exact: true })).toBeVisible();
    expect(variants).not.toContain("WORKPLACE_CHANGE");
    await sheet.getByRole("textbox", { name: /^사유/ }).fill("배치 검토");
    await picker.fill("재무팀");
    await page.getByRole("option", { name: /재무팀/ }).click();
    const relocated = page.getByRole("dialog", { name: "전근", exact: true });
    await expect(relocated).toBeVisible();
    await expect(relocated.getByRole("button", { name: "전근 1명 예약", exact: true })).toBeVisible();
    await expect(changes.locator('[data-id="site"]')).toHaveText("사업장본사→ 부산사업장");
    await expect(relocated).toContainText("전근합니다");
    await expect.poll(() => variants).toContain("WORKPLACE_CHANGE");
    await expect(relocated.getByRole("textbox", { name: /^사유/ })).toHaveValue("배치 검토");
    await fits(page, `move/${width}`);
    await expectAxe(page, `move/${width}`);
    await relocated.getByRole("combobox", { name: "어디로", exact: true }).fill("인사팀");
    await page.getByRole("option", { name: /인사팀/ }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("textbox", { name: /^사유/ })).toHaveValue("배치 검토");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`relocation refusal uses its own name at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = lifecycleSheetScreens[1];
    const fixture = await mockScreen(page, screen, "populated");
    await page.goto(screen.path);
    const menu = page.getByRole("dialog", { name: "발령", exact: true });
    const relocate = menu.getByRole("button", { name: /^전근 / });
    await expect(relocate).toHaveAttribute("aria-disabled", "true");
    await expect(relocate).toContainText("전근은 휴직 중에는 할 수 없습니다.");
    await fits(page, `move-menu/${width}`);
    await expectAxe(page, `move-menu/${width}`);
    expect(fixture.unexpected).toEqual([]);
  });
}
