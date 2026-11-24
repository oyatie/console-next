// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { id, screenAccess, structure } from "../mock/fixtures";
import { orgPanelReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { box, revealUnit } from "../structure-flows";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
  test(`inline department add keeps validation quiet during refresh at ${width}px in ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    const fixture = await mockScreen(page, screens[2], "populated");
    await orgPanelReads(page);
    const tree = structure(1);
    tree.phase = "SETUP";
    const parent = tree.entities[0]!.children[0]!;
    parent.children = [];
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "SETUP"), is_ops: true } });
    let saved = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/org-structure/change-dates", async () => {
      if (saved) await held;
      return { status: 200, json: { items: [] } };
    });
    await mockRoute(page, "post", "/api/v1/org-structure/batches", request => {
      const { ops } = request.postDataJSON() as { ops: { name: string }[] };
      parent.children.push({ ...parent, id: id(500), kind: "DEPARTMENT", name: ops[0]!.name, children: [] });
      saved = true;
      return { status: 201, json: { batch_id: id(501), change_mode: "SETUP", units: [{ op_index: 0, org_unit_id: id(500), version: 1 }] } };
    });
    try {
      await page.goto("/org");
      await revealUnit(page, parent.name);
      await page.keyboard.press("a");
      const field = page.getByRole("textbox", { name: `${parent.name} 아래 새 부서 이름` });
      await field.fill("개발팀");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({ path: test.info().outputPath(`before-${width}-${theme}.png`) });
      await field.press("Enter");
      await expect(box(page, "개발팀")).toHaveCount(1);
      await expect(field).toHaveAttribute("readonly", "");
      await page.screenshot({ path: test.info().outputPath(`refresh-${width}-${theme}.png`) });
      await expect(field).not.toHaveAttribute("aria-invalid", "true");
      await expect(page.getByRole("alert").filter({ hasText: "이미 있습니다" })).toHaveCount(0);
      release();
      await expect(field).toHaveValue("");
      await expect(field).toBeFocused();
      await page.screenshot({ path: test.info().outputPath(`after-${width}-${theme}.png`) });
      await fits(page, `department add/${width}/${theme}`);
      await field.fill("개발팀");
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByRole("alert").filter({ hasText: "이미 있습니다" })).toHaveCount(1);
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}

// The live journeys' default viewport: a held save's banner grows the bottom bar while the add field is open.
test("a held department add keeps the box it is added under clear of the chart's top band @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const tree = structure(1);
  tree.phase = "SETUP";
  const parent = tree.entities[0]!.children[0]!;
  parent.children = [];
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "SETUP"), is_ops: true } });
  await mockRoute(page, "get", "/api/v1/org-structure/change-dates", { status: 200, json: { items: [] } });
  let sent = false;
  await page.route(/\/api\/v1\/org-structure\/batches$/, async route => {
    if (sent || route.request().method() !== "POST") return route.fallback();
    sent = true;
    await page.context().setOffline(true);
    return route.abort("internetdisconnected");
  });
  try {
    await page.goto("/org");
    await box(page, parent.name).click();
    await page.keyboard.press("a");
    const field = page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: parent.name }), exact: true });
    await field.fill("Support");
    await field.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: t("requestOutcome.checking") })).toBeVisible();
    await expect(field).toHaveValue("Support");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // The keyboard's box (the one tab stop in the chart) must not sit under a floating bar's controls: covered, it fails
    // the 24 px target size and a press on it lands on the bar.
    const covered = await page.evaluate(() => {
      const cursor = document.querySelector('[role="treeitem"][tabindex="0"]')!;
      const c = cursor.getBoundingClientRect();
      return [...document.querySelectorAll("a[href], button, input, select, textarea")].filter(el => {
        if (cursor.contains(el) || el.closest('[role="tree"]')) return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.left < c.right && b.right > c.left && b.top < c.bottom && b.bottom > c.top;
      }).map(el => el.textContent?.trim() || el.getAttribute("aria-label"));
    });
    expect(covered).toEqual([]);
    await expectAxe(page, "held department add");
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.context().setOffline(false); await page.close(); fixture.release(); }
});
