// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screenAccess, structure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { orgPanelReads } from "../mock/org-work";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const empty of [false, true]) {
  test(`org: setup has one starting action without a second checklist (${empty ? "empty" : "populated"}, ${width}px) @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[2], "populated");
    const tree = structure(empty ? 0 : 3);
    tree.phase = "SETUP";
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/org", "SETUP") });
    try {
      await page.goto("/org");
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: t("structure.title"), exact: true })).toBeVisible();
      await expect(main.locator("#setup-panel-title, progress, ol[aria-label]")).toHaveCount(0);
      const head = main.getByRole("group", { name: t("structure.views"), exact: true }).locator("..");
      await expect(head).toBeVisible();
      if (width === 390) await expect(head.locator("p:empty")).toHaveCount(0);
      await expect(head.getByText(t("structure.phase.setupChip"), { exact: true })).toHaveCount(0);
      await expect(main.getByText(/되돌릴 수 있습니다|조직 구조는 법인|이미 엑셀로/)).toHaveCount(0);
      if (empty) {
        await expect(main.getByRole("region", { name: t("asof.label"), exact: true })).toHaveCount(0);
        await expect(main.getByRole("button", { name: t("asof.compare"), exact: true })).toHaveCount(0);
        await expect(main.getByRole("heading", { name: t("structure.first.title"), exact: true })).toBeVisible();
        await expect(main.getByRole("heading", { name: t("structure.first.title"), exact: true })).toHaveAttribute("id", "first-run-title");
        await expect(main.locator(".state .btn--primary")).toHaveCount(1);
        await expect(main.getByRole("link", { name: t("structure.first.addEntity"), exact: true })).toHaveAttribute("href", "/org/entities/new");
      } else {
        await expect(main.getByRole("tree")).toBeVisible();
        await expect(main.getByText(/기준 구조입니다|고용형태와 관계없이|Shift 클릭/)).toHaveCount(0);
        const basis = main.getByRole("button", { name: t("structure.headcount.explain"), exact: true });
        await expect(basis).toContainText(t("structure.headcount.total", { count: tree.entities.reduce((n, e) => n + e.headcount, 0) }));
        await expect(page.getByText(t("structure.headcount.basis"), { exact: true })).toHaveCount(0);
        await basis.click();
        await expect(page.getByRole("dialog", { name: t("structure.headcount.label"), exact: true }).getByText(t("structure.headcount.basis"), { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await fits(page, `org setup/${empty}/${width}/${theme}`);
        await expectAxe(page, `org setup/${empty}/${width}/${theme}`);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("org: list retains visible column headers at 390px @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  try {
    await page.goto("/org?view=list");
    const grid = page.getByRole("grid", { name: t("structure.list.label"), exact: true });
    const heading = grid.getByRole("columnheader", { name: t("structure.list.name"), exact: true });
    await expect(heading).toBeVisible();
    await expect(heading).toBeInViewport();
    await expect(grid.getByRole("rowheader").first()).toBeVisible();
    await fits(page, "org list/390");
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("org: an empty workplace remains clickable when its hover actions fall inside the card @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const tree = structure(1);
  tree.phase = "SETUP";
  tree.entities[0]!.children[0]!.children = [];
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  try {
    await page.goto("/org");
    const workplace = page.getByRole("treeitem", { name: /^본사,/ });
    await workplace.hover();
    await workplace.click({ timeout: 5000 });
    await expect(workplace).toHaveAttribute("aria-selected", "true");
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const view of ["chart", "list", "outline"] as const) {
  test(`org: ${view} keeps definitions and shortcuts on demand @ui-state`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[2], "populated");
    try {
      await page.goto(`/org?view=${view}`);
      const main = page.getByRole("main");
      await expect(main.getByRole(view === "list" ? "grid" : "tree").first()).toBeVisible();
      await expect(main.locator("p:visible").filter({ hasText: /키보드로 빠르게|Enter 아래에 추가|인원은 하위 조직|퇴직자를 제외한/ })).toHaveCount(0);
      if (view === "list") {
        await main.getByRole("columnheader").getByRole("button", { name: t("structure.headcount.explain"), exact: true }).click();
        await expect(page.getByRole("dialog", { name: t("structure.headcount.label"), exact: true }).getByText(t("structure.headcount.basis"), { exact: true })).toBeVisible();
        expect(fixture.unexpected).toEqual([]);
        return;
      }
      await page.getByRole("button", { name: t("structure.shortcuts.title"), exact: true }).focus();
      await page.keyboard.press("?");
      const help = page.getByRole("dialog", { name: t("structure.shortcuts.title"), exact: true });
      await expect(help).toBeVisible();
      await expect(help.getByText(t("structure.shortcuts.find"), { exact: true })).toBeVisible();
      const chartKeys = help.getByRole("region", { name: t("structure.view.chart"), exact: true });
      for (const key of ["Home", "End", "Shift F10", "ContextMenu", "Backspace", "Alt ↑", "Alt ↓", "Esc"]) {
        await expect(chartKeys.getByText(key, { exact: true })).toBeVisible();
      }
      if (view === "outline") await expect(help.getByText(t("structure.shortcuts.nest"), { exact: true })).toBeVisible();
      await expectAxe(page, `org ${view}/shortcuts`);
      await page.keyboard.press("Escape");
      await expect(help).toHaveCount(0);
      if (view === "chart") {
        const find = main.getByRole("searchbox", { name: t("structure.find.label"), exact: true });
        await find.fill("?");
        await find.press("?");
        await expect(help).toHaveCount(0);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("org: every bottom-bar button stays inside the canvas and clickable at 390px @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  try {
    await page.goto("/org");
    const canvas = page.getByRole("region", { name: t("structure.chart.label"), exact: true });
    const zoom = canvas.getByRole("group", { name: t("uiOrgCanvas.zoom"), exact: true });
    await expect(zoom.getByRole("button", { name: t("structure.collapseAll"), exact: true })).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const buttons = zoom.locator("..").getByRole("button");
      for (const button of await buttons.all()) {
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
        expect(await button.evaluate(el => {
          const rect = el.getBoundingClientRect();
          const bounds = el.closest("section")!.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom && el.contains(hit);
        }), await button.getAttribute("aria-label") ?? await button.textContent() ?? undefined).toBe(true);
        await button.click();
      }
    }
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("org: the gallery previews the empty state, count basis and keyboard help @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  try {
    await page.goto("/_gallery?entry=structure-copy");
    await expect(page.getByRole("heading", { name: t("structure.first.title"), exact: true })).toBeVisible();
    await page.getByRole("button", { name: t("structure.headcount.explain"), exact: true }).click();
    await expect(page.getByText(t("structure.headcount.basis"), { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: t("structure.shortcuts.title"), exact: true }).click();
    await expect(page.getByRole("dialog", { name: t("structure.shortcuts.title"), exact: true })).toBeVisible();
    await expectAxe(page, "org copy gallery");
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
