// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { mediaQueries } from "../breakpoints";
import { Button } from "./button";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  await loadCatalog("ko");
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

test("long-label non-block buttons clamp inside 320px viewports while compact Korean buttons stay single-line nowrap", async () => {
  const tokens = new URL("../../../../../packages/tokens/", import.meta.url);
  const read = (file: string, base: URL | string = import.meta.url) => readFileSync(new URL(file, base), "utf8");
  const experiences = readdirSync(new URL("experiences/", tokens))
    .filter(file => file.endsWith(".css"))
    .map(file => read(`experiences/${file}`, tokens));
  const css = [
    read("tokens.css", tokens),
    ...experiences,
    read("../../app.css").replace(/@import[^;]+;/g, ""),
    ".probe-wrap { padding: 8px; width: 100%; }",
  ]
    .join("\n")
    .replace(/\(--([\w-]+)\)/g, (query, name: string) => mediaQueries[name as keyof typeof mediaQueries] ?? query);

  const compactEdit = t("uiRecord.edit");
  const longLabel = "Send and confirm payroll statements for all selected recipients immediately without overflowing";
  const markup = renderToStaticMarkup(
    <main className="probe-wrap">
      <Button id="long-btn" variant="secondary">
        {longLabel}
      </Button>
      <Button id="compact-btn" size="sm">
        {compactEdit}
      </Button>
    </main>,
  );

  await page.setViewportSize({ width: 320, height: 640 });
  await page.setContent(
    `<!doctype html><html data-experience="console" data-theme="light"><body><style>${css}</style>${markup}</body></html>`,
  );

  for (const exp of ["console", null] as const) {
    const metrics = await page.evaluate(experience => {
      if (experience) document.documentElement.dataset.experience = experience;
      else delete document.documentElement.dataset.experience;
      const longBtn = document.getElementById("long-btn")!;
      const compactBtn = document.getElementById("compact-btn")!;
      const range = docRange();
      function docRange() {
        const r = document.createRange();
        r.selectNodeContents(compactBtn);
        return r;
      }
      return {
        docOverflow: document.documentElement.scrollWidth - 320,
        longRight: Math.round(longBtn.getBoundingClientRect().right),
        longMaxWidth: getComputedStyle(longBtn).maxWidth,
        longOverflow: getComputedStyle(longBtn).overflow,
        longTextOverflow: getComputedStyle(longBtn).textOverflow,
        compactWhiteSpace: getComputedStyle(compactBtn).whiteSpace,
        compactLines: range.getClientRects().length,
      };
    }, exp);
    expect(metrics.docOverflow).toBeLessThanOrEqual(0);
    expect(metrics.longRight).toBeLessThanOrEqual(320);
    expect(metrics.compactLines).toBe(1);
    if (exp === "console") {
      expect(metrics.longMaxWidth).toBe("100%");
      expect(metrics.longOverflow).toBe("hidden");
      expect(metrics.longTextOverflow).toBe("ellipsis");
      expect(metrics.compactWhiteSpace).toBe("nowrap");
    }
  }
});
