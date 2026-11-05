// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { fits } from "../a11y";
import { orgWorkReads } from "./org-work";
import { screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

for (const width of [1440, 390]) {
  for (const surface of ["org", "entity"] as const) test(`${surface} import reads CP949 CSV at ${width}px @ui-state`, async ({ page }, info) => {
    const fixture = await mockScreen(page, screens[2], "empty");
    await orgWorkReads(page, "empty");
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess(surface === "org" ? "/org/import" : "/org/entities/bulk", "SETUP") });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(surface === "org" ? "/org/import" : "/org/entities/bulk");
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "파일 선택", exact: true }).click();
      await (await chooser).setFiles({ name: "가져오기.csv", mimeType: "text/csv", buffer: Buffer.from(surface === "org"
        ? "c8b8bbe72cbbe7bef7c0e52cbacebcad0d0ab0cbc1f5b9fdc0ce2cbabbbbe72c8c63b0a1b3aa0d0a"
        : "b9fdc0ceb8ed2cb4ebc7a5c0da0d0a8c63b0a1b3aa2cb1e8b4ebc7a50d0a", "hex") });
      if (surface === "org") {
        await expect(page.getByRole("cell", { name: "똠가나", exact: true })).toBeVisible();
        await expect(page.getByRole("combobox", { name: "부서 열", exact: true })).toHaveValue("path");
      } else {
        const name = page.getByRole("combobox", { name: /^법인 이름/ });
        await expect(name.locator("option", { hasText: "법인명" })).toHaveCount(1);
        await name.selectOption("0");
        await page.getByRole("button", { name: "입력값 확인", exact: true }).click();
        await expect(page.getByRole("textbox", { name: /^법인명/ })).toHaveValue("똠가나");
        await expect(page.getByRole("textbox", { name: /^대표자/ })).toHaveValue("김대표");
      }
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await fits(page, `${surface} CSV/${width}/${theme}`);
        await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
