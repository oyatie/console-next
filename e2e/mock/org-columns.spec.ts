// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { authz, failure, id, screenAccess, structure } from "./fixtures";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

const VIEWS = ["chart", "list", "outline"] as const;
type View = (typeof VIEWS)[number];
const org = screens.find(screen => screen.key === "org")!;
const path = (view: View, search = "") => `/org?${[view === "chart" ? "" : `view=${view}`, search].filter(Boolean).join("&")}`;
const toolbar = (page: Page) => page.getByRole("group", { name: t("structure.toolbar"), exact: true });
const find = (page: Page) => toolbar(page).getByRole("searchbox", { name: t("structure.find.label"), exact: true });
const column = (page: Page, name: string) => page.getByRole("complementary", { name, exact: true });
const outline = (page: Page) => page.getByRole("tree", { name: t("structure.outline.label"), exact: true });
const grid = (page: Page) => page.getByRole("grid", { name: t("structure.list.label"), exact: true });
const outlineRow = (page: Page, name: string) => outline(page).getByRole("treeitem", { name: new RegExp(`^${name}\\s`) });
const box = (page: Page, unit: string) => page.locator(`[data-box][data-id="${unit}"]`);

/** The org page with the panel's reads; `setup` puts the tenant before go-live, where every edit applies in place. */
async function open(page: Page, { width = 1440, setup = false, asOf = "" } = {}) {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, org, "populated");
  const reads = await orgPanelReads(page);
  const tree = structure(3);
  if (setup) {
    tree.phase = "SETUP";
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/org", "SETUP") });
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities, { feature: "org_change_draft", permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false }] } });
  }
  if (asOf) await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: { ...tree, as_of: asOf, read_only: true } });
  const workplace = tree.entities[0]!.children[0]!;
  return { fixture, ...reads, tree, workplace, depts: workplace.children };
}

/** Selects a unit the way the view does: its box on the chart (found first), its row in the outline, its checkbox in the list. */
async function pick(page: Page, view: View, unit: { id: string; name: string }) {
  if (view === "chart") {
    await find(page).fill(unit.name);
    await find(page).press("Enter");
    await box(page, unit.id).click();
  } else if (view === "outline") await outlineRow(page, unit.name).click();
  else await grid(page).locator(`[data-row-id="${unit.id}"]`).getByRole("checkbox").check({ force: true });
}

for (const view of VIEWS) test(`org ${view}: a department's panel opens beside the view, survives a reload and Escape returns to the unit`, async ({ page }) => {
  const { fixture, dept } = await open(page);
  await page.goto(path(view));
  await pick(page, view, dept);
  await expect(page).toHaveURL(new RegExp(`sel=${dept.id}`));
  const panel = column(page, dept.name);
  await expect(panel.getByRole("heading", { name: dept.name, exact: true })).toBeVisible();
  // The head, the members, what is scheduled and the actions, as on the chart.
  for (const section of ["dept-basic", "dept-actions", "dept-members", "dept-history"]) await expect(panel.locator(`#${section}`)).toBeVisible();
  await expect(panel.getByRole("button", { name: "직원 1", exact: true })).toBeVisible();
  // One frame: the column closes it, the panel draws no second ✕.
  await expect(panel.getByRole("button", { name: t("common.closePanel"), exact: true })).toHaveCount(1);
  await expect(panel.getByRole("complementary")).toHaveCount(0);
  const surface = view === "chart" ? page.getByRole("region", { name: t("structure.chart.label"), exact: true }) : view === "outline" ? outline(page) : grid(page);
  const [left, right] = [(await surface.boundingBox())!, (await panel.boundingBox())!];
  expect(left.x + left.width, "the view stays beside the panel").toBeLessThanOrEqual(right.x + 1);
  await expectAxe(page, `org ${view} with a department panel`);
  await page.screenshot({ path: test.info().outputPath(`org-${view}-panel-1440.png`) });

  await page.reload();
  await expect(panel.getByRole("heading", { name: dept.name, exact: true })).toBeVisible();
  await panel.getByRole("heading", { name: dept.name, exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/sel=/);
  const origin = view === "chart" ? page.locator(`[id="node-${dept.id}"]`) : view === "outline" ? page.locator(`[id="outline-${dept.id}"]`) : grid(page).locator(`[data-row-id="${dept.id}"]`);
  await expect.poll(() => origin.evaluate(el => el.contains(document.activeElement))).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});

test("org outline: the tree is the list with a headcount on every row, the panel follows the cursor, and Enter and F2 still edit", async ({ page }) => {
  const { fixture, depts, workplace } = await open(page, { setup: true });
  await page.goto(path("outline"));
  await expect(outline(page).getByRole("treeitem")).toHaveCount(5);
  for (const row of await outline(page).getByRole("treeitem").all()) await expect(row).toContainText(/\d+명/);
  // The chart is its own view now: the tree alone fills the list column.
  await expect(page.getByRole("region", { name: t("structure.chart.label"), exact: true })).toHaveCount(0);

  await outlineRow(page, depts[0]!.name).click();
  await expect(column(page, depts[0]!.name)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(column(page, depts[1]!.name)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`sel=${depts[1]!.id}`));
  await expect(outlineRow(page, depts[1]!.name)).toBeFocused();

  // The columns leave the tree's keys alone: Enter adds below, F2 renames, and Esc ends the edit, not the panel.
  await page.keyboard.press("Enter");
  const add = page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: workplace.name }), exact: true });
  await expect(add).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(add).toHaveCount(0);
  await expect(column(page, depts[1]!.name)).toBeVisible();
  await expect(outlineRow(page, depts[1]!.name)).toBeFocused();
  await page.keyboard.press("F2");
  await expect(page.getByRole("textbox", { name: t("structure.edit.renameLabel", { name: depts[1]!.name }), exact: true })).toBeFocused();
  await page.keyboard.press("Escape");

  // Esc on a row clears the selection and leaves the cursor where it is.
  await expect(outlineRow(page, depts[1]!.name)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(outlineRow(page, depts[1]!.name)).toBeFocused();
  // With nothing selected the arrows only move the cursor.
  await page.keyboard.press("ArrowUp");
  await expect(outlineRow(page, depts[0]!.name)).toBeFocused();
  await page.waitForTimeout(400);
  await expect(page.getByRole("complementary")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

for (const view of VIEWS) test(`org ${view}: one toolbar carries the date, the find, add and fold all`, async ({ page }) => {
  const { fixture, depts, workplace } = await open(page, { setup: true });
  await page.goto(path(view));
  const bar = toolbar(page);
  await expect(bar.getByRole("region", { name: t("asof.label"), exact: true })).toHaveCount(1);
  await expect(page.getByRole("searchbox")).toHaveCount(1);
  const fold = bar.getByRole("button", { name: t("structure.collapseAll"), exact: true });
  await expect(page.getByRole("button", { name: t("structure.collapseAll"), exact: true })).toHaveCount(1);

  // The find reaches a department in every view: shown on the chart, under the cursor in the outline, kept in the list.
  await find(page).fill(depts[2]!.name);
  await find(page).press("Enter");
  if (view === "chart") await expect(box(page, depts[2]!.id)).toHaveAttribute("data-s", /now/);
  else if (view === "outline") await expect(outlineRow(page, depts[2]!.name)).toHaveAttribute("data-current", "true");
  else await expect(grid(page).locator("[data-row-id]")).toHaveCount(3);
  await expect(find(page)).toBeFocused();
  await find(page).press("Escape");
  await expect(find(page)).toHaveValue("");

  // `/` from the view goes to the one find field.
  if (view === "chart") await box(page, workplace.id).focus();
  else if (view === "outline") await outlineRow(page, workplace.name).focus();
  else await grid(page).locator(`[data-row-id="${workplace.id}"]`).getByRole("checkbox").focus();
  await page.keyboard.press("/");
  await expect(find(page)).toBeFocused();

  // + 추가 with nothing selected opens the inline editor under the first workplace: no dialog.
  await bar.getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
  const add = page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: workplace.name }), exact: true });
  await expect(add).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await add.press("Escape");

  // 모두 접기 folds the tree down to the legal entity, in the view shown.
  await fold.click();
  if (view === "chart") await expect(box(page, depts[0]!.id)).toHaveCount(0);
  else if (view === "outline") await expect(outline(page).getByRole("treeitem")).toHaveCount(1);
  else await expect(grid(page).locator("[data-row-id]")).toHaveCount(1);
  await expectAxe(page, `org ${view} toolbar`);
  await bar.screenshot({ path: test.info().outputPath(`org-${view}-toolbar.png`) });
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"]) test(`org outline at phone width: the tree is the one column and a unit opens with a way back (${theme})`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  const { fixture, dept } = await open(page, { width: 390 });
  await page.goto(path("outline"));
  await expect(outlineRow(page, dept.name)).toBeVisible();
  await fits(page, `org outline 390 ${theme}`);
  await outlineRow(page, dept.name).click();
  const panel = column(page, dept.name);
  await expect(panel.getByRole("heading", { name: dept.name, exact: true })).toBeVisible();
  await expect(outline(page)).toBeHidden();
  await fits(page, `org outline panel 390 ${theme}`);
  await expectAxe(page, `org outline panel 390 ${theme}`);
  await page.screenshot({ path: test.info().outputPath(`org-outline-panel-390-${theme}.png`), fullPage: true });
  await panel.getByRole("button", { name: t("common.back"), exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(outlineRow(page, dept.name)).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("org outline: a selection that arrives with the link is never rewritten by the cursor, and a proposal card keeps its place", async ({ page }) => {
  const { depts } = await open(page);
  // A unit the tree does not hold (ended since the link was made): the first row takes the cursor, the link stays.
  await page.goto(path("outline", `sel=${id(999)}`));
  await expect(outlineRow(page, depts[0]!.name)).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(new RegExp(`sel=${id(999)}`));

  // A proposal card holds the selection: walking the tree beside it must not close the card.
  await page.goto(path("outline", `act=create&sel=${depts[0]!.id}`));
  await expect(column(page, t("structure.side"))).toBeVisible();
  await outlineRow(page, depts[0]!.name).focus();
  await page.keyboard.press("ArrowDown");
  await expect(outlineRow(page, depts[1]!.name)).toBeFocused();
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/act=create/);
  await expect(column(page, t("structure.side"))).toBeVisible();
});

test("org chart: Escape cancels a drag even while a panel is open beside the chart", async ({ page }) => {
  const { depts } = await open(page, { setup: true });
  await page.goto(path("chart", `sel=${depts[0]!.id}`));
  await expect(column(page, depts[0]!.name)).toBeVisible();
  const from = (await box(page, depts[1]!.id).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 40, from.y + from.height / 2 + 10, { steps: 4 });
  const moving = page.getByRole("status").filter({ hasText: t("structure.drop.rules") });
  await expect(moving).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(moving).toHaveCount(0);
  await page.mouse.up();
});

test("org list: focus on another row leaves the selection alone, and a second tick turns the panel into a multi-selection", async ({ page }) => {
  const { fixture, depts } = await open(page);
  await page.goto(path("list"));
  await pick(page, "list", depts[0]!);
  await expect(column(page, depts[0]!.name)).toBeVisible();
  const second = grid(page).locator(`[data-row-id="${depts[1]!.id}"]`).getByRole("checkbox");
  await second.focus();
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(new RegExp(`sel=${depts[0]!.id}`));
  await expect(column(page, depts[0]!.name)).toBeVisible();
  await second.check({ force: true });
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(grid(page).locator('[data-row-id][aria-selected="true"]')).toHaveCount(2);
  expect(fixture.unexpected).toEqual([]);
});

test("org chart at phone width keeps the box on screen with its panel under it", async ({ page }) => {
  const { fixture, dept } = await open(page, { width: 390 });
  await page.goto(path("chart", `sel=${dept.id}`));
  const panel = column(page, dept.name);
  await expect(panel.getByRole("heading", { name: dept.name, exact: true })).toBeVisible();
  await expect(box(page, dept.id)).toBeVisible();
  await expect(panel.getByRole("button", { name: t("common.back"), exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: t("common.closePanel"), exact: true })).toHaveCount(1);
  await fits(page, "org chart panel 390");
  expect(fixture.unexpected).toEqual([]);
});

for (const [name, status, code, title] of [["failed", 503, "service_unavailable", "common.loadFailed.title"], ["refused", 403, "forbidden", "common.denied.panel"]] as const) {
  for (const width of [1440, 390]) test(`org outline: a ${name} workplace read is reported inside the column at ${width}px and the tree stays`, async ({ page }) => {
    const { workplace, depts } = await open(page, { width });
    await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}", { status, json: failure(code) });
    await page.goto(path("outline", `sel=${id(4)}`));
    const panel = column(page, workplace.name);
    await expect(panel.getByText(t(title), { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    if (width === 1440) await expect(outlineRow(page, depts[0]!.name)).toBeVisible();
    await fits(page, `org ${name} panel ${width}`);
    await expectAxe(page, `org ${name} panel ${width}`);
  });
}

for (const width of [1440, 390]) test(`org outline: a past date shows the panel without its actions at ${width}px`, async ({ page }) => {
  const { fixture, dept } = await open(page, { width, asOf: "2026-02-01" });
  await page.goto(path("outline", `sel=${dept.id}&as_of=2026-02-01`));
  const panel = column(page, dept.name);
  await expect(panel.locator("#dept-basic")).toBeVisible();
  await expect(panel.locator("#dept-actions")).toHaveCount(0);
  await expect(toolbar(page).getByRole("button", { name: t("structure.tools.addDept"), exact: true })).toHaveCount(0);
  await fits(page, `org past date panel ${width}`);
  await expectAxe(page, `org past date panel ${width}`);
  expect(fixture.unexpected).toEqual([]);
});
