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

test("disabled primary buttons use solid muted surfaces in console while leaving baseline unaltered", async () => {
  const tokens = new URL("../../../../../packages/tokens/", import.meta.url);
  const read = (file: string, base: URL | string = import.meta.url) => readFileSync(new URL(file, base), "utf8");
  const experiences = readdirSync(new URL("experiences/", tokens))
    .filter(file => file.endsWith(".css"))
    .map(file => read(`experiences/${file}`, tokens));
  const css = [
    read("tokens.css", tokens),
    ...experiences,
    read("../../app.css").replace(/@import[^;]+;/g, ""),
    ".probe-wrap { padding: 8px; display: flex; gap: 8px; }",
  ]
    .join("\n")
    .replace(/\(--([\w-]+)\)/g, (query, name: string) => mediaQueries[name as keyof typeof mediaQueries] ?? query);

  const saveLabel = t("uiRecord.edit");
  const submitLabel = t("common.retry");
  const draftLabel = t("common.cancel");
  const markup = renderToStaticMarkup(
    <main className="probe-wrap">
      <Button id="aria-disabled-primary" variant="primary" aria-disabled="true">
        {saveLabel}
      </Button>
      <Button id="native-disabled-primary" variant="primary" disabled>
        {submitLabel}
      </Button>
      <Button id="native-disabled-secondary" disabled>
        {draftLabel}
      </Button>
      <Button id="native-disabled-ghost" variant="ghost" disabled>
        {draftLabel}
      </Button>
      <Button id="native-disabled-ghost-danger" variant="ghost-danger" disabled>
        {draftLabel}
      </Button>
    </main>,
  );

  await page.setViewportSize({ width: 640, height: 320 });
  await page.setContent(
    `<!doctype html><html data-experience="console" data-theme="light"><body><style>${css}</style>${markup}</body></html>`,
  );

  const consoleMetrics = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const muted = root.getPropertyValue("--muted").trim();
    const steel = root.getPropertyValue("--steel").trim();
    const border = root.getPropertyValue("--border").trim();
    const probe = document.createElement("span");
    probe.style.backgroundColor = muted;
    probe.style.color = steel;
    probe.style.borderColor = border;
    document.body.appendChild(probe);
    const expected = {
      bg: getComputedStyle(probe).backgroundColor,
      color: getComputedStyle(probe).color,
      borderColor: getComputedStyle(probe).borderTopColor,
    };
    probe.remove();

    const readBtn = (id: string) => {
      const el = document.getElementById(id)!;
      const cs = getComputedStyle(el);
      return {
        borderStyle: cs.borderTopStyle,
        opacity: cs.opacity,
        cursor: cs.cursor,
        bg: cs.backgroundColor,
        color: cs.color,
        borderColor: cs.borderTopColor,
      };
    };
    return {
      expected,
      ariaPrimary: readBtn("aria-disabled-primary"),
      nativePrimary: readBtn("native-disabled-primary"),
      nativeSecondary: readBtn("native-disabled-secondary"),
      nativeGhost: readBtn("native-disabled-ghost"),
      nativeGhostDanger: readBtn("native-disabled-ghost-danger"),
    };
  });

  expect(consoleMetrics.ariaPrimary.borderStyle).toBe("solid");
  expect(consoleMetrics.ariaPrimary.opacity).toBe("1");
  expect(consoleMetrics.ariaPrimary.cursor).toBe("not-allowed");
  expect(consoleMetrics.ariaPrimary.bg).toBe(consoleMetrics.expected.bg);
  expect(consoleMetrics.ariaPrimary.color).toBe(consoleMetrics.expected.color);
  expect(consoleMetrics.ariaPrimary.borderColor).toBe(consoleMetrics.expected.borderColor);
  expect(consoleMetrics.nativePrimary.borderStyle).toBe("solid");
  expect(consoleMetrics.nativeSecondary.borderStyle).toBe("solid");
  expect(consoleMetrics.nativeGhost.bg).toBe("rgba(0, 0, 0, 0)");
  expect(consoleMetrics.nativeGhostDanger.bg).toBe("rgba(0, 0, 0, 0)");

  await page.hover("#aria-disabled-primary");
  const hoveredBg = await page.evaluate(() => getComputedStyle(document.getElementById("aria-disabled-primary")!).backgroundColor);
  expect(hoveredBg).toBe(consoleMetrics.expected.bg);

  for (const ghostId of ["native-disabled-ghost", "native-disabled-ghost-danger"] as const) {
    await page.hover(`#${ghostId}`);
    const ghostHover = await page.evaluate(id => {
      const cs = getComputedStyle(document.getElementById(id)!);
      return { bg: cs.backgroundColor, borderColor: cs.borderTopColor };
    }, ghostId);
    expect(ghostHover.bg).toBe("rgba(0, 0, 0, 0)");
    expect(ghostHover.borderColor).toBe("rgba(0, 0, 0, 0)");
  }

  // Baseline remains unaltered
  await page.evaluate(() => {
    delete document.documentElement.dataset.experience;
  });
  const baselineStyle = await page.evaluate(() => getComputedStyle(document.getElementById("aria-disabled-primary")!).borderTopStyle);
  expect(baselineStyle).toBe("dashed");
});
