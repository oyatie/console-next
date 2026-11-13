// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go } from "../flows";
import { fits } from "../a11y";
import { failure, structure } from "./fixtures";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

for (const width of [1440, 390]) test(`erasing a department leaves its reads before refreshing the chart at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  const { dept } = await orgPanelReads(page);
  const tree = structure(3);
  const parent = tree.entities[0]!.children[0]!;
  let erased = false;
  const rereads: string[] = [];
  await mockRoute(page, "get", "/api/v1/org-structure", () => ({ status: 200, json: tree }));
  await mockRoute(page, "get", "/api/v1/org-structure/units/{orgUnitId}/end-options", { status: 200, json: {
    org_unit_id: dept.id, name: dept.name, version: 1, phase: "OPERATING", delete: { allowed: true }, dissolve: { allowed: false, refusal: "org_unit_never_used" }, members: 0, people_ever: 0, units: 0, can_manage: true,
  } });
  await page.route(url => url.pathname.includes(dept.id), async route => {
    if (erased && route.request().method() === "GET") {
      rereads.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 404, json: failure("not_found") });
    }
    return route.fallback();
  });
  await mockRoute(page, "post", "/api/v1/org-structure/units/{orgUnitId}/erase", request => {
    expect(request.postDataJSON()).toEqual({ expected_version: 1 });
    expect(request.headers()["idempotency-key"]).toBeTruthy();
    erased = true;
    parent.children = parent.children.filter(node => node.id !== dept.id);
    return { status: 200, json: { id: dept.id, erased: 1, change_mode: "SETUP" } };
  });
  await go(page, `/org?sel=${dept.id}&act=dept-delete`);
  await page.locator("html").evaluate(el => { el.dataset.theme = "dark"; });
  const sheet = page.getByRole("dialog", { name: `${dept.name} 삭제 · 폐지` });
  const submit = sheet.getByRole("button", { name: "부서 1개 삭제", exact: true });
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveCount(1);
  await fits(page, "department erase sheet");
  await submit.click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`sel=${parent.id}$`));
  await expect(page.getByRole("complementary", { name: dept.name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: new RegExp(`^${dept.name},`) })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(rereads).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
