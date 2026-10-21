import type { Page } from "@playwright/test";
import { atPhoneWidth } from "./a11y";

/** A full-page screenshot into $STRUCT_SHOTS when set (a fix's before/after evidence); nothing otherwise. */
export const shot = (page: Page, name: string) =>
  process.env.STRUCT_SHOTS ? page.screenshot({ path: `${process.env.STRUCT_SHOTS}/${name}.png`, fullPage: true }).then(() => undefined) : Promise.resolve();

/** Lets the shell's scrolling panes out to their content for a full-page capture. */
export async function withFullPage(page: Page, capture: () => Promise<unknown>) {
  await page.evaluate(() => {
    for (const el of [document.documentElement, document.body, ...document.querySelectorAll<HTMLElement>("body *")]) {
      const st = getComputedStyle(el);
      if (el === document.documentElement || el === document.body || ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight)) {
        el.dataset.parityFull = el.getAttribute("style") ?? "";
        Object.assign(el.style, { overflow: "visible", height: "auto", maxHeight: "none" });
      }
    }
  });
  try {
    await capture();
  } finally {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-parity-full]")) {
        el.setAttribute("style", el.dataset.parityFull ?? "");
        delete el.dataset.parityFull;
      }
    });
  }
}

/** The same screen in both themes at desktop and phone width, restoring the caller's view afterwards. */
export async function shotSet(page: Page, name: string) {
  if (!process.env.STRUCT_SHOTS) return;
  const html = page.locator("html"), theme = await html.getAttribute("data-theme"), viewport = page.viewportSize();
  const capture = (suffix: string) => withFullPage(page, () => shot(page, `${name}--${suffix}`));
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const mode of ["light", "dark"]) {
      await html.evaluate((el, t) => (el.dataset.theme = t), mode);
      await capture(`1440-${mode}`);
      await atPhoneWidth(page, () => capture(`390-${mode}`));
    }
  } finally {
    await html.evaluate((el, t) => (t === null ? delete el.dataset.theme : (el.dataset.theme = t)), theme);
    if (viewport) await page.setViewportSize(viewport);
  }
}
