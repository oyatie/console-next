import { writeFileSync } from "node:fs";
import { type Page } from "@playwright/test";
import { shot } from "./shot";

/** Supplementary states have no manifest frame; keep them distinct from frame-ID captures. */
export async function scene(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot(page, name);
  await shot(page, name, { dark: true });
  writeFileSync(`node_modules/.cache/parity/scene-${name}.json`, JSON.stringify({
    name, url: new URL(page.url()).pathname, text: await page.locator("body").innerText(),
  }));
}
