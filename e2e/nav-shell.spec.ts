// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectAccessible, fits } from "./a11y";
import { go, registerEmployee, routeReady } from "./flows";
import { SETUP_DEPARTMENT, setupCompany, startOperations, tenantBeforeSetup } from "./setup-flows";
import { forgetResize } from "./stability";

const rail = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });
const topLinks = (page: Page) => rail(page).locator(":scope > div > ul > li > a");

async function captureRail(page: Page, info: TestInfo, phase: string) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await forgetResize(page);
    if (width === 390) await page.getByRole("button", { name: "메뉴", exact: true }).click();
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme)
        await page.getByRole("button", { name: theme === "dark" ? "어두운 화면으로 전환" : "밝은 화면으로 전환" }).click();
      await expectAccessible(page, `${phase} rail ${width} ${theme}`);
      await fits(page, `${phase} rail ${width}`);
      await page.screenshot({ path: info.outputPath(`${phase}-${width}-${theme}.png`), fullPage: true });
    }
    if (width === 390) await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await forgetResize(page);
}

test("the rail grows from setup facts and keeps module navigation flat", async ({ browser }, info) => {
  const { admin, exec } = await tenantBeforeSetup(browser, "navshell", "메뉴검증회사", false, "none");
  await go(admin, "/");
  await expect(topLinks(admin)).toHaveText(["홈", "조직 구조", "권한"]);
  await go(exec, "/");
  await expect(topLinks(exec)).toHaveText(["홈"]);
  await captureRail(admin, info, "setup");

  // Readiness still hides unusable modules when the checklist is refused.
  await admin.route("**/api/v1/onboarding/checklist", route => route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "권한이 없습니다" } } }));
  await admin.reload();
  await routeReady(admin, "/");
  await expect(topLinks(admin)).toHaveText(["홈", "조직 구조", "권한"]);
  // If both reads fail, preserve S1's useful, permitted fallback.
  await admin.route("**/api/v1/onboarding/modules", route => route.fulfill({ status: 503, json: { error: { code: "unavailable" } } }));
  await admin.reload();
  await routeReady(admin, "/");
  await expect(topLinks(admin)).toHaveText(["홈", "조직 구조", "직원", "권한"]);
  await admin.unroute("**/api/v1/onboarding/checklist");
  await admin.unroute("**/api/v1/onboarding/modules");
  await admin.reload();
  await routeReady(admin, "/");
  await expect(topLinks(admin)).toHaveText(["홈", "조직 구조", "권한"]);

  await setupCompany(admin, "메뉴검증회사");
  await go(admin, "/");
  await expect(topLinks(admin)).toHaveText(["홈", "조직 구조", "직원", "권한"]);
  await go(admin, "/people");
  await registerEmployee(admin, { name: "메뉴직원", number: "NAV-001", unit: SETUP_DEPARTMENT });
  const operatingModules = admin.waitForResponse(async response => response.url().endsWith("/api/v1/onboarding/modules") && response.ok() &&
    (await response.json() as { key: string; ready: boolean }[]).some(module => module.key === "attendance" && module.ready));
  await startOperations(admin);
  await operatingModules;
  await go(admin, "/people");
  await expect(topLinks(admin)).toHaveText(["홈", "변경 요청", "조직 구조", "직원", "근태", "법정 신고·서류", "권한", "감사 기록", "설정"]);
  await go(admin, "/people");
  await expectAccessible(admin, "operating return to people");
  await captureRail(admin, info, "operating");

  await go(admin, "/org/entities");
  await expect(admin.getByRole("main").getByRole("link", { name: "법인·사업장", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(rail(admin).getByRole("link", { name: "조직 구조", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(rail(admin).getByRole("link", { name: "법인·사업장", exact: true })).toHaveCount(0);
  await expect(rail(admin).getByRole("link", { name: "퇴직 진행", exact: true })).toHaveCount(0);
  await rail(admin).getByRole("link", { name: "직원", exact: true }).click();
  const exits = admin.getByRole("main").getByRole("navigation", { name: "직원", exact: true }).getByRole("link", { name: "퇴직 진행", exact: true });
  await exits.click();
  await expect(exits).toHaveAttribute("aria-current", "page");
  await expect(admin).toHaveURL(/\/people\?tab=exits$/);
  await expect(rail(admin).getByRole("link", { name: "직원", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(rail(admin).getByRole("link", { name: "퇴직 진행", exact: true })).toHaveCount(0);
  await expect(rail(admin).locator("ul ul")).toHaveCount(0);
  await expect(rail(admin).getByRole("link", { name: "법인·사업장", exact: true })).toHaveCount(0);
  await rail(admin).getByRole("link", { name: "설정", exact: true }).click();
  await admin.getByRole("main").getByRole("link", { name: "기간 잠금", exact: true }).click();
  await expect(rail(admin).getByRole("link", { name: "설정", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(rail(admin).locator('[aria-current="page"]')).toHaveCount(1);
  await go(admin, "/requests");
  await expect(admin.getByRole("main").getByRole("heading", { level: 1 })).toHaveText("요청 결과");
  await expect(rail(admin).getByRole("link", { name: "요청 결과", exact: true })).toHaveCount(0);

  await exec.reload();
  await go(exec, "/");
  await expect(topLinks(exec)).toHaveText(["홈", "변경 요청"]);
  await rail(exec).getByRole("link", { name: "변경 요청", exact: true }).click();
  await expect(exec).toHaveURL(/\/people\/requests$/);
  await expect(exec.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await expectAccessible(exec, "requester navigation");
});
