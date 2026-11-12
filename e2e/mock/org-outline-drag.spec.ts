// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe } from "../a11y";
import { authz, id, screenAccess, structure } from "./fixtures";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

const org = screens.find(screen => screen.key === "org")!;
const outline = (page: Page) => page.getByRole("tree", { name: t("structure.outline.label"), exact: true });
const row = (page: Page, name: string) => outline(page).getByRole("treeitem", { name: new RegExp(`^${name}\\s`) });
const hint = (page: Page) => page.getByRole("main").getByRole("status").filter({ hasText: /./ }).last();

/** The tree during setup, where a move applies at once; `moves` collects what the page sends. */
async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockScreen(page, org, "populated");
  await orgPanelReads(page);
  const tree = structure(3);
  tree.phase = "SETUP";
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/org", "SETUP") });
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities, { feature: "org_change_draft", permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false }] } });
  const moves: unknown[] = [];
  await page.route("**/api/v1/org-structure/batches", route => {
    if (route.request().method() !== "POST") return route.fallback();
    moves.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, json: { batch_id: id(9), change_mode: "SETUP", units: [] } });
  });
  const workplace = tree.entities[0]!.children[0]!;
  await page.goto("/org?view=outline");
  await expect(row(page, workplace.children[0]!.name)).toBeVisible();
  return { fixture, moves, entity: tree.entities[0]!, workplace, depts: workplace.children };
}

/** Presses on one row and carries it to another, as a pointer does: past the drag threshold, then onto the target. */
async function carry(page: Page, from: string, to: string) {
  const a = (await row(page, from).boundingBox())!, b = (await row(page, to).boundingBox())!;
  await page.mouse.move(a.x + 80, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 90, a.y + a.height / 2 + 8, { steps: 3 });
  await page.mouse.move(b.x + 90, b.y + b.height / 2, { steps: 6 });
}

test("org tree: a department dragged onto another shows where it lands and moves on release", async ({ page }, info) => {
  const { fixture, moves, depts } = await open(page);
  await carry(page, depts[2]!.name, depts[0]!.name);
  await expect(row(page, depts[0]!.name)).toHaveAttribute("data-drop", "ok");
  await expect(outline(page).locator("[data-insert]")).toHaveCount(1);
  // The line sits under the row that takes it, one level in: the unit becomes its last child.
  const target = (await row(page, depts[0]!.name).boundingBox())!, line = (await outline(page).locator("[data-insert]").boundingBox())!;
  expect(line.y).toBeGreaterThanOrEqual(target.y + target.height - 1);
  expect(line.x).toBeGreaterThan(target.x);
  await expect(hint(page)).toContainText(depts[2]!.name);
  await expectAxe(page, "org tree while dragging");
  await page.screenshot({ path: info.outputPath("org-tree-drag.png") });
  await page.mouse.up();
  await expect.poll(() => moves.length).toBe(1);
  expect(moves[0]).toMatchObject({ ops: [{ op: "MOVE", org_unit_id: depts[2]!.id, parent_org_unit_id: depts[0]!.id }] });
  await expect(outline(page).locator("[data-insert]")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("org tree: a place that cannot take the department says why and a release there sends nothing", async ({ page }) => {
  const { moves, entity, depts } = await open(page);
  await carry(page, depts[2]!.name, entity.name);
  await expect(row(page, entity.name)).toHaveAttribute("data-drop", "no");
  await expect(outline(page).locator("[data-insert]")).toHaveCount(0);
  await expect(hint(page)).toHaveText(t("structure.drop.entityOnlySites"));
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(moves).toEqual([]);
});

test("org tree: Escape cancels a drag and closes nothing beside the tree", async ({ page }) => {
  const { moves, depts } = await open(page);
  await row(page, depts[1]!.name).click();
  await expect(page.getByRole("complementary", { name: depts[1]!.name, exact: true })).toBeVisible();
  await carry(page, depts[2]!.name, depts[0]!.name);
  await expect(row(page, depts[0]!.name)).toHaveAttribute("data-drop", "ok");
  await page.keyboard.press("Escape");
  await expect(outline(page).locator("[data-drop]")).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(moves).toEqual([]);
  // The press moved the cursor to the dragged row, so the panel follows it as on any press; Esc closed nothing.
  await expect(page.getByRole("complementary", { name: depts[2]!.name, exact: true })).toBeVisible();
});

test("org tree: a finger never arms a drag, and a press the browser cancels leaves nothing armed", async ({ page }) => {
  const { moves, depts } = await open(page);
  const from = (await row(page, depts[2]!.name).boundingBox())!, to = (await row(page, depts[0]!.name).boundingBox())!;
  const fire = (type: string, pointerType: string, x: number, y: number) => page.evaluate(([type, pointerType, x, y]) => {
    const target = type === "pointerdown" ? document.elementFromPoint(x as number, y as number)! : document;
    target.dispatchEvent(new PointerEvent(type as string, { pointerType: pointerType as string, pointerId: 7, button: 0, clientX: x as number, clientY: y as number, bubbles: true, cancelable: true }));
  }, [type, pointerType, x, y] as const);
  // A touch that would be a scroll: press, move, then a release over another row.
  await fire("pointerdown", "touch", from.x + 80, from.y + from.height / 2);
  await fire("pointermove", "touch", to.x + 90, to.y + to.height / 2);
  await expect(outline(page).locator("[data-drop], [data-moving]")).toHaveCount(0);
  await fire("pointerup", "touch", to.x + 90, to.y + to.height / 2);
  // A pen drag the browser takes over mid-way: the cancel ends it, and a later release drops nothing.
  await fire("pointerdown", "pen", from.x + 80, from.y + from.height / 2);
  await fire("pointermove", "pen", from.x + 90, from.y + from.height / 2 + 8);
  await fire("pointermove", "pen", to.x + 90, to.y + to.height / 2);
  await expect(row(page, depts[0]!.name)).toHaveAttribute("data-drop", "ok");
  await fire("pointercancel", "pen", to.x + 90, to.y + to.height / 2);
  await expect(outline(page).locator("[data-drop], [data-moving]")).toHaveCount(0);
  await fire("pointermove", "pen", to.x + 90, to.y + to.height / 2);
  await fire("pointerup", "pen", to.x + 90, to.y + to.height / 2);
  await page.waitForTimeout(300);
  expect(moves).toEqual([]);
});

test("org tree: M opens the same move as a picker for the keyboard", async ({ page }) => {
  const { moves, depts } = await open(page);
  await row(page, depts[2]!.name).focus();
  await page.keyboard.press("m");
  const picker = page.getByRole("dialog", { name: t("structure.move.title", { name: depts[2]!.name }), exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole("row", { name: new RegExp(`^${depts[0]!.name}`) }).click();
  await picker.getByRole("button", { name: t("structure.move.submit", { name: depts[0]!.name }), exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect.poll(() => moves.length).toBe(1);
  expect(moves[0]).toMatchObject({ ops: [{ op: "MOVE", org_unit_id: depts[2]!.id, parent_org_unit_id: depts[0]!.id }] });
  // The key is listed with the tree's other keys.
  await page.getByRole("button", { name: t("structure.shortcuts.title"), exact: true }).click();
  await expect(page.getByRole("dialog", { name: t("structure.shortcuts.title"), exact: true }).getByText(t("structure.shortcuts.move"), { exact: true }).first()).toBeVisible();
});
