// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { id, screenAccess } from "./fixtures";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

const locker = { id: id(21), label: "사물함 번호", value_type: "TEXT", section: "PERSONAL", visibility: "MANAGERS", choices: [], active: true };
const shirt = { id: id(22), label: "작업복 치수", value_type: "CHOICE", section: "JOB", visibility: "MANAGERS", choices: [{ id: id(31), label: "M" }], active: true };

for (const width of [1440, 390]) test(`card fields are added, extended and retired at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[0], "empty");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/people/roster-fields") });
  const writes: { method: string; path: string; body: unknown }[] = [];
  await mockRoute(page, "get", "/api/v1/roster-fields", { status: 200, json: { can_manage: true, active_limit: 30, items: [locker, shirt] } });
  await mockRoute(page, "post", "/api/v1/roster-fields", request => {
    writes.push({ method: "POST", path: new URL(request.url()).pathname, body: request.postDataJSON() });
    return { status: 201, json: { ...shirt, id: id(23), label: "근무 조", choices: [{ id: id(32), label: "주간" }, { id: id(33), label: "야간" }] } };
  });
  await mockRoute(page, "patch", "/api/v1/roster-fields/{id}", request => {
    writes.push({ method: "PATCH", path: new URL(request.url()).pathname, body: request.postDataJSON() });
    return { status: 200, json: shirt };
  });
  await page.goto("/people/roster-fields");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: t("rosterFields.title"), exact: true })).toBeVisible();
  await expect(main.getByText("작업복 치수").first()).toBeVisible();
  await fits(page, `roster fields ${width}`);
  await expectAxe(page, `roster fields ${width}`);
  await page.screenshot({ path: info.outputPath(`roster-fields-${width}.png`), fullPage: true });

  // A choice field needs its options before it is sent.
  const add = main.getByRole("form", { name: t("rosterFields.add"), exact: true });
  await add.getByRole("textbox", { name: t("rosterFields.col.label") }).fill("근무 조");
  await add.getByRole("radio", { name: t("rosterFields.type.CHOICE"), exact: true }).press("Space");
  await add.getByRole("radio", { name: t("rosterFields.section.JOB"), exact: true }).press("Space");
  await add.getByRole("button", { name: t("rosterFields.add.commit"), exact: true }).click();
  await expect(add).toContainText(t("rosterFields.choices.missing"));
  expect(writes).toEqual([]);
  await add.getByRole("textbox", { name: t("rosterFields.choices") }).fill("주간\n야간\n");
  await add.getByRole("button", { name: t("rosterFields.add.commit"), exact: true }).click();
  await expect(main.getByRole("status").filter({ hasText: "근무 조" })).toBeVisible();
  expect(writes[0]).toEqual({ method: "POST", path: "/api/v1/roster-fields", body: { label: "근무 조", value_type: "CHOICE", section: "JOB", choices: [{ label: "주간" }, { label: "야간" }] } });

  // An option is added beside the ones kept; none is removed.
  await main.getByRole("button", { name: t("rosterFields.edit", { label: "작업복 치수" }), exact: true }).click();
  const edit = main.getByRole("form", { name: t("rosterFields.edit.title", { label: "작업복 치수" }) });
  await edit.getByRole("textbox", { name: t("rosterFields.choices.more") }).fill("L");
  await edit.getByRole("button", { name: t("rosterFields.edit.commit"), exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ method: "PATCH", path: `/api/v1/roster-fields/${id(22)}`, body: { choices: [{ id: id(31), label: "M" }, { label: "L" }] } });

  await main.getByRole("button", { name: t("rosterFields.retire", { label: "사물함 번호" }), exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toEqual({ method: "PATCH", path: `/api/v1/roster-fields/${id(21)}`, body: { active: false } });
  expect(fixture.unexpected).toEqual([]);
});

test("without the right to keep them, the fields are read only", async ({ page }) => {
  const fixture = await mockScreen(page, screens[0], "empty");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/people/roster-fields") });
  await mockRoute(page, "get", "/api/v1/roster-fields", { status: 200, json: { can_manage: false, active_limit: 30, items: [locker] } });
  await page.goto("/people/roster-fields");
  const main = page.getByRole("main");
  await expect(main.getByText("사물함 번호").first()).toBeVisible();
  await expect(main.getByRole("status")).toHaveText(t("rosterFields.denied"));
  await expect(main.getByRole("form")).toHaveCount(0);
  await expect(main.getByRole("button", { name: t("rosterFields.retire", { label: "사물함 번호" }), exact: true })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
