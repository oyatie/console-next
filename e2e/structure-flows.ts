import { loadCatalog, t } from "@console/i18n";
import { expect, type Page, type Locator } from "@playwright/test";
import { clearShifts } from "./stability";

// The company structure chart (/org), through the product: boxes are treeitems named "name, level, headcount".

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A box on the chart (or a row of the outline) by its unit name. */
export const box = (page: Page, name: string) => page.getByRole("tree", { name: /조직도$/ }).getByRole("treeitem", { name: new RegExp(`^${esc(name)},`) });

/** Selects `parent` on the chart and clicks add and types each new 부서 under it (Enter per name), then closes the box. */
export async function addDepartments(page: Page, parent: string, names: readonly string[]) {
  // Found, not assumed on screen: a box in the DOM may sit panned outside the canvas.
  await revealUnit(page, parent);
  await page.getByRole("toolbar", { name: `${parent} 작업` }).getByRole("button", { name: /부서 추가$/ }).click();
  const input = page.getByRole("textbox", { name: new RegExp(`^${esc(parent)} 아래 새 부서 이름`) });
  for (const name of names) {
    await input.fill(name);
    await input.press("Enter");
    // The new box lands with the save's re-read: a state wait, however long the save takes under host load.
    await box(page, name).waitFor();
    await expect(input).toBeEnabled();
  }
  await input.press("Escape");
  await expect(input).toBeHidden();
}

/** The latest receipt docked under the chart (it stays until dismissed or replaced). */
export const receipt = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("button", { name: "되돌리기" }) });

/**
 * Brings a unit into view by name (find, Enter), wherever it sits. A unit just added from a side panel reaches the
 * chart with its re-read, so the find is repeated until it lands on it.
 */
export async function findBox(page: Page, name: string) {
  const find = page.getByRole("searchbox", { name: "조직 찾기" });
  await expect(async () => {
    await find.fill(name);
    await find.press("Enter");
    // The find has landed on it (a 사업장 box is drawn either way): the current hit is marked and brought into view.
    await expect(box(page, name)).toHaveAttribute("data-s", /\bnow\b/, { timeout: 1_000 });
  }).toPass({ intervals: [500, 1_000, 2_000], timeout: 15_000 });
  await find.press("Escape");
}

/**
 * Finds a unit and waits until its box takes a press: a re-read landing after the find (a unit just added) can lay the
 * chart out again and leave the box under a floating bar, as a person would see it move and find it again.
 * Press the name: the hover action can cover the box's centre when the chart is zoomed out.
 */
export async function findPressable(page: Page, name: string) {
  // The name precedes any flags, which can repeat it (a workplace named 본점).
  const target = box(page, name).getByText(name, { exact: true }).first();
  await expect(async () => {
    await findBox(page, name);
    await target.click({ trial: true, timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return target;
}

/** Brings a unit into view by name, wherever it sits, and selects its box. */
export async function revealUnit(page: Page, name: string) {
  await (await findPressable(page, name)).click();
  await expect(box(page, name)).toBeFocused();
}

/**
 * Starts the layout-stability record afresh once a spec leaves screens it only passes through (the 법인 and 사업장
 * forms, audited by their own specs), so the chart's checks judge the chart.
 */
export const leaveScreen = (page: Page) => page.evaluate(clearShifts);

/** The inline editor's shared controls, after go-live. */
export async function inlineUnitDetails(page: Page, scope: Page | Locator, date?: string) {
  await loadCatalog("ko");
  await scope.getByRole("button", { name: t("orgUnit.gov.reason"), exact: true }).click();
  const reason = page.getByRole("dialog", { name: t("orgUnit.gov.reason"), exact: true }).getByRole("textbox");
  await reason.fill("조직 운영 계획");
  await reason.press("Escape");
  if (date) {
    await scope.getByRole("button", { name: new RegExp(`^${t("orgUnit.gov.date")} · `) }).click();
    const field = page.getByRole("dialog", { name: t("orgUnit.gov.date"), exact: true }).getByRole("textbox", { name: new RegExp(`^${t("orgUnit.gov.date")}`) });
    await field.fill(date);
    await field.press("Enter");
  }
}
