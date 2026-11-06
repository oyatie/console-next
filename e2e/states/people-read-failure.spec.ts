// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { failure, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const scenario of ["shared", "distinct", "usable"] as const) test(`people read failure: ${scenario} @ui-state`, async ({ page }, info) => {
  const rosterFailed = scenario !== "usable";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
  await mockScreen(page, screens[1], "populated");
  const paths = ["/api/v1/employees", "/api/v1/settings", "/api/v1/me/employee-views"] as const;
  const replies = new Map<string, number>();
  for (const [index, path] of paths.entries()) {
    if (index === 0 && !rosterFailed) continue;
    const body = failure("service_unavailable");
    body.error.support_ref = id(scenario === "shared" ? 90 : 90 + index).replaceAll("-", "");
    await mockRoute(page, "get", path, () => {
      replies.set(path, (replies.get(path) ?? 0) + 1);
      return { status: 503, json: body };
    });
  }
  await page.goto("/people");
  for (const path of paths.slice(rosterFailed ? 0 : 1)) await expect.poll(() => replies.get(path) ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  const main = page.getByRole("main");
  await expect(main.locator('[aria-busy="true"]:visible:not([aria-hidden="true"] *, [inert] *)')).toHaveCount(0);
  const references = main.locator("[data-support-reference]");
  await expect(references).toHaveCount(rosterFailed ? 1 : 2);
  if (rosterFailed) await expect(references).toHaveAttribute("data-support-reference", id(90).replaceAll("-", ""));
  if (!rosterFailed) {
    await expect(references.nth(0)).toHaveAttribute("data-support-reference", id(92).replaceAll("-", ""));
    await expect(references.nth(1)).toHaveAttribute("data-support-reference", id(91).replaceAll("-", ""));
    await expect(main.getByRole("grid", { name: t("people.table"), exact: true })).toBeVisible();
  }
  await fits(page, "people read failures");
  await info.attach("people-read-failure", { body: await page.screenshot({ path: info.outputPath("people-read-failure.png"), fullPage: true }), contentType: "image/png" });
});
