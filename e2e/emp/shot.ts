import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, type Page } from "@playwright/test";
import { withFullPage } from "../shots";

// Mockup parity captures (employee-ux/final, spec §6): each frame at 1440×900, device scale 2, saved as PNG under
// PARITY_OUT (unset: the capture spec skips). The parity page converts them to JPEG.
export const PARITY_OUT = process.env.PARITY_OUT;
export const parityUse = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } as const;

/** Saves the viewport (or the full page) as `<frame>.png`; `dark` flips the theme for the shot only. */
export async function shot(page: Page, frame: string, opts: { full?: boolean; dark?: boolean } = {}) {
  if (!PARITY_OUT) return;
  const dir = path.join(PARITY_OUT, test.info().project.name === "firefox" ? "firefox" : "chromium");
  mkdirSync(dir, { recursive: true });
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");
  if (opts.dark) await html.evaluate((el) => (el.dataset.theme = "dark"));
  await page.evaluate(() => document.fonts.ready);
  const capture = () => page.screenshot({ path: path.join(dir, `${frame}.png`), fullPage: opts.full, animations: "disabled", caret: "hide" });
  if (opts.full) await withFullPage(page, capture);
  else await capture();
  if (opts.dark) await html.evaluate((el, t) => (t === null ? delete el.dataset.theme : (el.dataset.theme = t)), before);
}
