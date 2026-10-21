import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test, type Page } from "@playwright/test";

// Mockup parity captures: the built screen in the mockup's state, viewport (1440×900, deviceScaleFactor 2) and
// theme. Only runs with PARITY_OUT set (a directory); the normal suites skip it.

export const OUT = process.env.PARITY_OUT ?? "";
export const parity = () => test.skip(!OUT, "parity capture: set PARITY_OUT");
export const VIEW = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, actionTimeout: 15_000 } as const;

/** One frame: `name` as the mockup's file name (E3-register), `dark` for its --dark variant. */
export async function shot(page: Page, name: string, o: { dark?: boolean; full?: boolean } = {}) {
  mkdirSync(OUT, { recursive: true });
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");
  if (o.dark) await html.evaluate((el) => (el.dataset.theme = "dark"));
  await page.evaluate(() => document.fonts.ready);
  // Let toasts, tints and focus rings settle as a person would see them.
  await page.waitForTimeout(300);
  const engine = test.info().project.use.browserName === "firefox" ? "--firefox" : "";
  await page.screenshot({ path: path.join(OUT, `${name}${o.dark ? "--dark" : ""}${engine}${o.full ? "--full" : ""}.png`), fullPage: o.full });
  if (o.dark) await html.evaluate((el, t) => (t === null ? delete el.dataset.theme : (el.dataset.theme = t)), before);
}

/**
 * Runs one frame's steps; a failure is recorded (OUT/failures.txt and a --error shot) instead of ending the capture,
 * so one broken frame does not hide the others. The parity index grades a missing frame as GAP.
 */
export async function frame(page: Page, name: string, steps: () => Promise<void>) {
  try {
    await steps();
  } catch (e) {
    mkdirSync(OUT, { recursive: true });
    appendFileSync(path.join(OUT, "failures.txt"), `${name}: ${String(e).split("\n").slice(0, 6).join(" | ")}\n`);
    await page.screenshot({ path: path.join(OUT, `${name}--error.png`) }).catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
  }
}
