// SPDX-License-Identifier: LicenseRef-Proprietary
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

// The browsers' own link and visited colours: Chromium and WebKit light, Chromium dark (color-scheme: dark), Firefox dark.
const UA_COLOURS = ["rgb(0,0,238)", "rgb(85,26,139)", "rgb(158,158,255)", "rgb(208,173,240)", "rgb(140,140,255)", "rgb(255,173,255)"];

/** Anchors in the browser's default look on the current screen, in the light and the dark theme. */
export async function rawAnchors(page: Page, where: string) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const found: string[] = [];
  const html = page.locator("html");
  const original = await html.getAttribute("data-theme");
  const anchors = await page.locator("a").count();
  for (const theme of ["light", "dark"]) {
    await html.evaluate((el, t) => (el.dataset.theme = t), theme);
    const bad = await page.evaluate((ua) => {
      const flat = (c: string) => c.replace(/\s+/g, "");
      return [...document.querySelectorAll("a")].flatMap((a) => {
        const s = getComputedStyle(a);
        const colour = flat(s.color);
        const what = `${a.textContent?.trim().slice(0, 30) || a.getAttribute("href")} (${colour}, ${s.textDecorationLine})`;
        if (ua.includes(colour)) return [`UA colour: ${what}`];
        if (s.textDecorationLine.includes("underline") && flat(s.textDecorationColor) === colour) return [`underline at rest: ${what}`];
        return [];
      });
    }, UA_COLOURS);
    found.push(...bad.map((b) => `[${theme}] ${where}: ${b}`));
    // Links read apart from the text around them (WCAG 1.4.1) and keep their contrast, in both themes.
    if (!anchors) continue;
    const { violations } = await new AxeBuilder({ page }).withRules(["link-in-text-block", "color-contrast"]).include("a").analyze();
    for (const v of violations) found.push(`[${theme}] ${where}: axe ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  }
  await html.evaluate((el, t) => (t === null ? delete el.dataset.theme : (el.dataset.theme = t)), original);
  return found;
}
