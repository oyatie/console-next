// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { failure, id } from "../mock/fixtures";
import { STALE_TIME_MS } from "../../apps/web/src/lib/freshness";
import { mockPeopleImport } from "../mock/people-import";
import { mockRoute } from "../mock/route";
import { peopleImportScreens, type PeopleImportState } from "./people-import";

const failedReads: Partial<Record<PeopleImportState, string>> = { "entities-failed": "법인", "numbers-failed": "사번 규칙", "reasons-failed": "사유 코드" };

for (const screen of peopleImportScreens) for (const state of Object.keys(screen.states) as PeopleImportState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await mockPeopleImport(page, state);
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main");
      const choose = main.getByRole("button", { name: "파일 선택", exact: true });
      if (state === "loading") {
        await expect(main.locator("[data-read-layout]")).toBeVisible();
        await expect(choose).toHaveAttribute("aria-disabled", "true");
        await choose.click({ force: true });
        await expect(main.locator('input[type="file"]')).toHaveCount(0);
      } else if (state.endsWith("failed")) {
        const card = main.getByRole("alert");
        await expect(card).toContainText("불러오지 못했습니다", { timeout: 20_000 });
        const label = failedReads[state];
        if (label) await expect(card).toContainText(`${label} 정보를 불러오지 못했습니다.`);
        await expect(card).toContainText(id(99));
        await expect(choose).toHaveAttribute("aria-disabled", "true");
        await expect(main.locator('input[type="file"]')).toHaveCount(0);
        await expect(main.getByRole("button", { name: "다시 불러오기", exact: true })).toHaveCount(1);
        if (state === "token-refresh-failed") expect(fixture.refreshes()).toBeGreaterThan(1);
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
        await expect(choose).toHaveAttribute("aria-disabled", "true");
        await expect(choose).toHaveAccessibleDescription("이 화면에 필요한 권한이 이 계정에 없습니다. 권한 관리 담당자에게 필요한 범위를 요청하십시오.");
        await expect(main.locator('input[type="file"]')).toHaveCount(0);
      } else {
        await expect(choose).toBeEnabled();
        await expect(choose).not.toHaveAttribute("aria-disabled", "true");
        await expect(main.getByRole("heading", { name: "최근 가져오기", exact: true })).toBeVisible();
        if (state === "populated") await expect(main.getByRole("link", { name: "synthetic-roster.xlsx" })).toBeVisible();
        else await expect(main.getByText("이 보기에 해당하는 행이 없습니다.", { exact: true })).toBeVisible();
      }
      await expect(page.getByText("화면을 표시하지 못했습니다", { exact: true })).toHaveCount(0);
      await fits(page, `${screen.key}/${state}/${width}`);
      // System serif fallback exposes the stepper's wider font metrics on macOS too.
      await page.addStyleTag({ content: "main { font-family: serif; }" });
      await fits(page, `${screen.key}/${state}/${width}/fallback-font`);
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("reference retry recovers the same import screen @ui-state", async ({ page }) => {
  const fixture = await mockPeopleImport(page, "entities-failed");
  try {
    await page.goto("/people/import");
    await expect(page.getByRole("alert")).toContainText("법인 정보를 불러오지 못했습니다.", { timeout: 20_000 });
    await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [] } });
    await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
    await expect(page.getByRole("button", { name: "파일 선택", exact: true })).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("a failed cached entities refetch keeps the completed run report @ui-state", async ({ page }) => {
  const fixture = await mockPeopleImport(page, "populated");
  try {
    await page.goto("/people/import");
    const recordedRun = page.getByRole("link", { name: "synthetic-roster.xlsx" });
    await expect(recordedRun).toBeVisible();
    await page.clock.setSystemTime(new Date(Date.now() + STALE_TIME_MS + 1));
    let failures = 0;
    await mockRoute(page, "get", "/api/v1/legal-entities", () => {
      failures++;
      return { status: 503, json: failure("service_unavailable") };
    });
    await recordedRun.click();
    await expect.poll(() => failures, { timeout: 20_000 }).toBe(3);
    await expect(page.locator("#import-done")).toHaveText("명부를 반영했습니다");
    await expect(page.getByRole("main")).toContainText("synthetic-roster.xlsx");
    await expect(page.getByRole("button", { name: "파일 선택", exact: true })).toHaveCount(0);
    await expect(page.getByText("법인 정보를 불러오지 못했습니다.", { exact: true })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
