import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, type Page } from "@playwright/test";

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
  // A full frame: the shell scrolls inside its own panes, so those are let out to their content for the shot.
  if (opts.full)
    await page.evaluate(() => {
      for (const el of [document.documentElement, document.body, ...document.querySelectorAll<HTMLElement>("body *")]) {
        const st = getComputedStyle(el);
        if (el === document.documentElement || el === document.body || ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight)) {
          el.dataset.parityFull = el.getAttribute("style") ?? "";
          Object.assign(el.style, { overflow: "visible", height: "auto", maxHeight: "none" });
        }
      }
    });
  await page.screenshot({ path: path.join(dir, `${frame}.png`), fullPage: opts.full, animations: "disabled", caret: "hide" });
  if (opts.full)
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-parity-full]")) {
        el.setAttribute("style", el.dataset.parityFull ?? "");
        delete el.dataset.parityFull;
      }
    });
  if (opts.dark) await html.evaluate((el, t) => (t === null ? delete el.dataset.theme : (el.dataset.theme = t)), before);
}
