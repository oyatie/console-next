import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { expectStable, forgetResize } from "./stability";

const TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

/**
 * Axe (WCAG 2.2 AA) on the current screen, in the light and the dark theme: fails on any
 * serious or critical violation, naming the rule and the offending selectors. Call it only
 * after the screen has settled (an expect(...).toBeVisible() on its content). The screen's
 * layout stability is checked first (e2e/stability.ts).
 */
export async function expectAccessible(page: Page, context: string, options: { openPicker?: boolean } = {}) {
  await expectStable(page, context);
  await expectAxe(page, context, options);
}

/** State matrices scan the settled state; live journeys also check arrival shifts through expectAccessible. */
export async function expectAxe(page: Page, context: string, options: { openPicker?: boolean; include?: string } = {}) {
  const html = page.locator("html");
  const original = await html.getAttribute("data-theme");
  const found: string[] = [];
  for (const theme of ["light", "dark"]) {
    await html.evaluate((el, t) => (el.dataset.theme = t), theme);
    const scan = new AxeBuilder({ page }).withTags(TAGS);
    if (options.include) scan.include(options.include);
    // React Aria's virtual-focus combobox deliberately leaves hidden content in the tab order.
    if (options.openPicker) scan.disableRules(["aria-hidden-focus"]);
    const { violations } = await scan.analyze();
    for (const v of violations.filter((v) => v.impact === "serious" || v.impact === "critical"))
      found.push(`[${theme}] ${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  }
  await html.evaluate((el, t) => (t === null ? delete el.dataset.theme : (el.dataset.theme = t)), original);
  expect.soft(found, `axe violations on ${context}:\n${found.join("\n")}`).toEqual([]);
}

/** At phone width (390px) no screen scrolls sideways: neither the page nor the main column. */
export async function fits(page: Page, screen: string) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector(".main")!;
    return { page: document.scrollingElement!.scrollWidth - innerWidth, main: main.scrollWidth - main.clientWidth };
  });
  expect(overflow, `${screen} scrolls sideways at 390px`).toEqual({ page: 0, main: 0 });
}

/** Runs `body` at phone width (390×844), then puts the desktop viewport back. */
export async function atPhoneWidth(page: Page, body: () => Promise<void>) {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await forgetResize(page);
  try {
    await body();
  } finally {
    if (before) await page.setViewportSize(before);
    await forgetResize(page);
  }
}
