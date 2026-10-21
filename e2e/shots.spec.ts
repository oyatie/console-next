// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFile, readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { shotSet } from "./shots";

test("shotSet captures inner scroll panes at every size and restores the page", async ({ page }, info) => {
  await page.setContent('<html data-theme="light" style="height:100%;overflow:hidden"><body style="margin:0;height:100%;overflow:hidden"><main style="height:100%;overflow:auto"><div style="height:2000px">masked birth date</div></main></body></html>');
  const styles = await page.locator("html, body, main").evaluateAll((els) => els.map((el) => el.getAttribute("style")));
  const viewport = page.viewportSize();
  const before = process.env.STRUCT_SHOTS;
  const dir = info.outputPath("shots");
  try {
    delete process.env.STRUCT_SHOTS;
    await shotSet(page, "unset");
    expect(await readdir(info.outputDir).catch(() => [])).toEqual([]);
    process.env.STRUCT_SHOTS = dir;
    await shotSet(page, "panes");
    for (const width of [1440, 390]) {
      for (const theme of ["light", "dark"]) {
        const png = await readFile(`${dir}/panes--${width}-${theme}.png`);
        expect(png.readUInt32BE(16)).toBe(width);
        expect(png.readUInt32BE(20), `${width}-${theme} includes the pane's content`).toBeGreaterThanOrEqual(2000);
      }
    }
    expect(await page.locator("html, body, main").evaluateAll((els) => els.map((el) => el.getAttribute("style")))).toEqual(styles);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(page.viewportSize()).toEqual(viewport);
  } finally {
    if (before === undefined) delete process.env.STRUCT_SHOTS;
    else process.env.STRUCT_SHOTS = before;
  }
});
