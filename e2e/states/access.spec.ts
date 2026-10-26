// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { mockRoute } from "../mock/route";
import { AT, id } from "../mock/fixtures";
import { accessRole, accessScreens, mockAccessScreen } from "./access";

for (const screen of accessScreens) for (const state of screen.states) for (const phase of ["SETUP", "OPERATING"] as const) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} ${phase} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await mockAccessScreen(page, screen, state, phase);
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main");
      if (state === "failed") {
        await expect(main.getByText("불러오지 못했습니다", { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("heading", { name: /부여 0건|부여가 없습니다|아직 역할이 없습니다/ })).toHaveCount(0);
        await expect(main.getByRole("searchbox")).toHaveCount(0);
        await expect(main.getByRole("button", { name: /일 안에 끝나는 부여/ })).toHaveCount(0);
        await main.getByRole("button", { name: "다시 불러오기", exact: true }).click();
        await expect(main.getByText("불러오지 못했습니다", { exact: true })).toBeVisible({ timeout: 20_000 });
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toHaveCount(1);
        await expect(main.getByRole("table").or(main.getByRole("grid"))).toHaveCount(0);
      } else if (state === "loading") {
        await expect(main.locator("[data-read-layout]")).toBeVisible();
        await expect(main.getByRole("heading", { name: /부여 0건|부여가 없습니다|아직 역할이 없습니다/ })).toHaveCount(0);
      } else if (state === "empty") {
        await expect(main.getByRole("heading", { name: screen.key === "access-grants" ? "부여가 없습니다" : "아직 역할이 없습니다", exact: true })).toBeVisible();
        await expect(main.getByRole("searchbox")).toHaveCount(0);
      } else {
        if (screen.key === "access-roles") await expect(main.getByRole("link", { name: state === "long" ? "한국정밀서비스 전국사업운영지원본부 인사조직관리 담당" : accessRole.name_ko, exact: true })).toBeVisible();
        else await expect(main.getByText("ACC-0001", { exact: true }).first()).toBeVisible();
        if (screen.key === "access-grants") {
          await expect(main.getByRole("searchbox")).toHaveCount(1);
          if (width === 390) {
            await expect(main.locator('[data-layout="cards"]')).toBeVisible();
            await expect(main.getByRole("columnheader", { name: `부여 ${fixture.count.toLocaleString("ko-KR")}건 / ${fixture.count.toLocaleString("ko-KR")}건`, exact: true })).toHaveCSS("clip-path", "inset(50%)");
          }
          if (width === 1440 && (state === "populated" || state === "long")) {
            const cells = main.getByRole("grid").locator('[role="gridcell"], [role="rowheader"]');
            await expect(cells).toHaveCount(fixture.count * 7);
            await expect.poll(() => cells.evaluateAll(elements => elements
              .filter(el => el.scrollWidth > el.clientWidth)
              .map(el => ({ text: el.textContent, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))),
            { message: "Every grant cell must fit its content at 1440px" }).toEqual([]);
            if (state === "populated") await expect.poll(() => cells.evaluateAll(elements => elements
              .flatMap(el => [...el.querySelectorAll<HTMLElement>("*")])
              .filter(el => el.scrollWidth > el.clientWidth)
              .map(el => el.textContent)),
            { message: "No text inside a grant cell is cut off at 1440px" }).toEqual([]);
          }
          await expect(main.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" })).toHaveCount(0);
          if (state === "large") {
            const table = main.getByRole("grid");
            expect(await table.getByRole("row").count()).toBeLessThan(100);
            await table.evaluate(el => { el.scrollTop = el.scrollHeight; });
            await expect(table.getByText("ACC-2000", { exact: true })).toBeVisible();
          }
        }
      }
      // Roles reflow belongs to slice 3; this slice registers its existing states without changing that screen.
      if (screen.key === "access-grants") await fits(page, `${screen.key}/${state}/${phase}/${width}`);
      await expectAxe(page, `${screen.key}/${state}/${phase}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}

test("role filter names its holders and resets; the single search filters and restores rows", async ({ page }) => {
  const fixture = await mockAccessScreen(page, accessScreens[0], "populated");
  await page.goto(`/access/grants?role=${accessRole.id}`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "인사 조회 보유자 3명", exact: true })).toBeVisible();
  await main.getByRole("searchbox").fill("존재하지 않는 사람");
  await expect(main.getByRole("heading", { name: "조건에 맞는 부여가 없습니다", exact: true })).toBeVisible();
  await main.getByRole("link", { name: "필터 초기화", exact: true }).click();
  await expect(page).toHaveURL(/\/access\/grants$/);
  await expect(main.getByRole("searchbox")).toHaveValue("");
  await expect(main.getByText("ACC-0001", { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("header grant action opens the shared picker dialog, then the existing grant sheet", async ({ page }) => {
  const fixture = await mockAccessScreen(page, accessScreens[0], "populated");
  await page.goto("/access/grants");
  const action = page.getByRole("main").getByRole("button", { name: "권한 부여", exact: true });
  await action.click();
  const picker = page.getByRole("dialog", { name: "권한 부여할 사람", exact: true });
  await picker.getByRole("combobox").fill("ACC-0002");
  await expect(page.getByRole("listbox")).toBeVisible();
  await picker.getByRole("combobox").press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("combobox")).toBeFocused();
  await picker.getByRole("button", { name: "취소", exact: true }).click();
  await expect(action).toBeFocused();
  await action.click();
  await picker.getByRole("combobox").fill("ACC-0002");
  await expectAxe(page, "grant account picker");
  await page.getByRole("option", { name: /ACC-0002/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "권한 부여", exact: true })).toContainText("검증직원 2");
  await page.keyboard.press("Escape");
  await expect(action).toBeFocused();
  expect(fixture.unexpected).toEqual([]);
});

test("an open request names its grant action and leaves one header grant action", async ({ page }) => {
  const fixture = await mockAccessScreen(page, accessScreens[0], "populated");
  const requester = fixture.accounts[1]!;
  await mockRoute(page, "get", "/api/v1/access/requests", { status: 200, json: [{
    id: id(40), requested_by: requester.id, requester_name: requester.display_name,
    screen: "/people", reason_code: "NEW_DUTY", status: "OPEN", created_at: AT,
  }] });
  await page.goto("/access/grants");
  const requests = page.getByRole("region", { name: "열린 권한 요청 1건" });
  await expect(requests).toBeVisible();
  await expect(page.getByRole("button", { name: "권한 부여", exact: true })).toHaveCount(1);
  await requests.getByRole("button", { name: /검증직원 2.*권한 부여/ }).click();
  await expect(page.getByRole("dialog", { name: "권한 부여", exact: true })).toContainText("검증직원 2");
  expect(fixture.unexpected).toEqual([]);
});

test("clearing the picker selection preserves employee-number confirmation for namesakes", async ({ page }) => {
  const fixture = await mockAccessScreen(page, accessScreens[0], "populated");
  const accounts = fixture.accounts.map(account => ({ ...account, display_name: "김동명", employee_name: "김동명" }));
  await mockRoute(page, "get", "/api/v1/users", { status: 200, json: { items: accounts, total: accounts.length, limit: 200, offset: 0 } });
  await page.goto("/access/grants");
  await page.getByRole("button", { name: "권한 부여", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "권한 부여할 사람", exact: true });
  await picker.getByRole("combobox").fill("김동명");
  await page.getByRole("option", { name: /ACC-0002/ }).click();
  await expect(page.getByRole("dialog", { name: "권한 부여", exact: true })).toHaveCount(0);
  await picker.getByRole("textbox", { name: /끝 4자리/ }).fill("0002");
  await expect(page.getByRole("dialog", { name: "권한 부여", exact: true })).toContainText("ACC-0002");
  expect(fixture.unexpected).toEqual([]);
});
