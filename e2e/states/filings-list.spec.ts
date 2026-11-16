// SPDX-License-Identifier: LicenseRef-Proprietary
import { i18n, loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { expect } from "@playwright/test";
import { test } from "../locale-fixture";
import { expectAxe, fits } from "../a11y";
import { filingRow } from "../helpers/statutory";
import { mockRoute } from "../mock/route";
import { filingTask, mockFilings } from "../mock/filings";
import { id } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`filing facts and actions reflow at ${width}px in ${theme} @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[2], "populated");
    await mockFilings(page, { ...filingTask, lifecycle_case_id: id(8300) });
    try {
      await page.goto("/statutory");
      await expect(page.getByText(filingTask.name, { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath("filings.png"), fullPage: true });
      const grid = page.getByRole("table", { name: t("statutory.insurance"), exact: true });
      await expect(grid).toHaveCSS("--table-cards", width === 390 ? "1" : "0");
      if (width === 390) {
        const region = page.getByRole("region", { name: t("statutory.insurance"), exact: true });
        expect(await region.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
      }
      const row = grid.getByRole("row").filter({ hasText: filingTask.name });
      if (width === 390) {
        const title = row.locator('[data-card="title"]');
        await expect(title).toHaveAttribute("data-label", t("statutory.employee"));
        await expect(title).toContainText(filingTask.name);
        for (const key of ["statutory.workplace", "statutory.event", "statutory.date", "statutory.deadline", "statutory.evidence"] as const) {
          const cell = row.locator(`[data-card="fact"][data-label="${t(key)}"]`);
          await expect(cell).toBeVisible();
          expect(await cell.evaluate(element => getComputedStyle(element, "::before").content)).toBe(JSON.stringify(t(key)));
        }
      }
      await expect(row.getByRole("link", { name: new RegExp(filingTask.name) })).toHaveAttribute("href", `/people/${id(100)}`);
      for (const value of [filingTask.employee_number!, filingTask.workplace_name!, t("statutory.NPS"), t("statutory.ACQUIRE"), fmtDate(filingTask.effective_date), t("statutory.days", { days: 3 })]) {
        await expect(row).toContainText(value);
      }
      await expect(row.getByRole("link", { name: t("lifecycle.trail.openCase"), exact: true })).toHaveAttribute("href", /case%3A/);
      await expect(row.getByRole("button", { name: t("statutory.record"), exact: true })).toBeVisible();
      const basis = row.getByText(t("statutory.basis"), { exact: true });
      await expect(row.getByText(t("statutory.hold"), { exact: true })).not.toBeVisible();
      await basis.click();
      await expect(row.getByText(t("statutory.hold"), { exact: true })).toHaveCount(1);
      await expect(row.getByText(t("statutory.hold"), { exact: true })).toBeVisible();
      await expect(row.getByRole("link", { name: /국민연금법/ })).toHaveCount(0);
      await expect(row.getByText(new RegExp(new URL(filingTask.basis!.citation.source_url).pathname))).toBeVisible();
      expect(await row.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll("*")].filter(child => {
          const box = child.getBoundingClientRect();
          return box.width > 1 && (box.right > bounds.right + 1 || box.left < bounds.left - 1);
        }).length;
      })).toBe(0);
      await fits(page, `filings ${width} ${theme}`);
      await expectAxe(page, `filings ${width} ${theme}`);
      await basis.click();
      await row.getByRole("button", { name: t("statutory.record"), exact: true }).click();
      const dialog = page.getByRole("dialog", { name: t("statutory.completeTitle", { name: filingTask.name, insurer: t("statutory.NPS"), kind: t("statutory.ACQUIRE") }) });
      await expect(dialog.getByRole("button", { name: t("statutory.preview"), exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await page.getByRole("button", { name: t("statutory.done"), exact: true }).click();
      await expect(grid).toContainText("RECEIPT-001");
      await expect(grid.getByRole("button", { name: t("statutory.undo"), exact: true })).toBeVisible();
      await fits(page, `filings completed ${width} ${theme}`);
      await expectAxe(page, `filings completed ${width} ${theme}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("filing search keeps the server filter and clears it on reset @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  const queries = await mockFilings(page);
  try {
    await page.goto("/statutory");
    const search = page.getByRole("searchbox", { name: t("statutory.search") });
    await search.fill("없는 직원");
    await search.press("Enter");
    await expect(page.getByRole("heading", { name: t("statutory.empty"), exact: true })).toBeVisible();
    expect(queries.some(query => query.get("search") === "없는 직원")).toBe(true);
    await search.fill("");
    await expect(page.getByRole("table", { name: t("statutory.insurance"), exact: true })).toContainText(filingTask.name);
    await page.goto("/_gallery");
    const gallery = page.locator("#gallery-filings");
    await gallery.scrollIntoViewIfNeeded();
    await expect(gallery.getByRole("table", { name: t("statutory.insurance"), exact: true })).toBeVisible();
    await gallery.getByRole("button", { name: t("statutory.record"), exact: true }).click();
    await expect(gallery.getByRole("status")).toHaveText(t("statutory.record"));
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("translated filing labels fit their phone card cell at 390px @ui-state", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
  const fixture = await mockScreen(page, screens[2], "populated");
  await mockFilings(page, { ...filingTask, insurer: "EI" });
  try {
    await loadCatalog("en");
    i18n.set("en");
    await page.goto("/statutory");
    const grid = page.getByRole("table", { name: t("statutory.insurance"), exact: true });
    await expect(grid).toContainText(filingTask.name, { timeout: 20_000 });
    await expect(grid).toHaveCSS("--table-cards", "1");
    const filing = grid.getByRole("cell", { name: `${t("statutory.EI")} · ${t("statutory.ACQUIRE")}` });
    expect(await filing.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().right - element.getBoundingClientRect().right;
    })).toBeLessThanOrEqual(1);
    await fits(page, "translated filing labels");
    await expectAxe(page, "translated filing labels");
    await page.screenshot({ path: info.outputPath("filings-translated.png"), fullPage: true });
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const width of [768, 600]) test(`filing words and actions stay whole at ${width}px @ui-state`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const fixture = await mockScreen(page, screens[2], "populated");
  const task = { ...filingTask, insurer: "EI", lifecycle_case_id: id(8300), workplace_name: "서울 본사 인사 지원 사업장" };
  await mockFilings(page, task);
  try {
    await page.goto("/statutory");
    const grid = page.getByRole("table", { name: t("statutory.insurance"), exact: true });
    await expect(grid).toContainText(task.name, { timeout: 20_000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.screenshot({ path: info.outputPath("filing-width.png"), fullPage: true });
    await fits(page, `filing words ${width}`);
    await expect(grid).toHaveCSS("--table-cards", "0");
    const row = grid.getByRole("row").filter({ hasText: task.name });
    const event = row.getByRole("cell", { name: `${t("statutory.EI")} · ${t("statutory.ACQUIRE")}`, exact: true });
    for (const control of [event, ...await row.getByRole("button").all(), ...await row.getByRole("link", { name: t("lifecycle.trail.openCase"), exact: true }).all()]) {
      expect(await control.evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        const lines = new Set<number>();
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue;
          range.selectNodeContents(walker.currentNode);
          for (const rect of range.getClientRects()) if (rect.width) lines.add(Math.round(rect.top));
        }
        return lines.size;
      }), "filing event and action text stays on one line").toBe(1);
    }
    expect(await row.locator("td").evaluateAll(cells => cells.flatMap(cell => {
      const style = getComputedStyle(cell);
      const available = cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const canvas = document.createElement("canvas").getContext("2d")!;
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      const broken: string[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (!range.getBoundingClientRect().width) continue;
        const font = getComputedStyle(node.parentElement!);
        if (font.overflowWrap === "anywhere") continue;
        canvas.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
        for (const word of node.textContent!.trim().split(/[\s-]+/)) {
          if (canvas.measureText(word).width > available + 1) broken.push(word);
        }
      }
      return broken;
    })), "each cell fits its longest word").toEqual([]);
    const workplace = row.getByRole("cell", { name: task.workplace_name, exact: true });
    expect(await workplace.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size;
    }), "long cell text wraps between words").toBeGreaterThan(1);
    const region = page.getByRole("region", { name: t("statutory.insurance"), exact: true });
    await expect(region).toHaveAttribute("tabindex", "0");
    expect(await region.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
    await region.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await expectAxe(page, `filing words ${width}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`filing density and evidence stay readable at ${width}px in ${theme} @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[2], "populated");
    await mockFilings(page);
    const exempt = { ...filingTask, event_id: id(8200), name: "김미해당", state: "NOT_APPLICABLE", record_action: "NOT_APPLICABLE" as const,
      not_applicable_reason: "OTHER_LEGAL_GROUND" as const, detail: "공단 확인" };
    await mockRoute(page, "get", "/api/v1/statutory/insurance-filings", {
      status: 200, json: { items: [filingTask, exempt], total: 2, pending: 1, next: null },
    });
    try {
      await page.goto("/statutory");
      const rows = page.getByRole("table", { name: t("statutory.insurance"), exact: true }).getByRole("row").filter({ hasText: t("statutory.ACQUIRE") });
      await expect(rows).toHaveCount(2);
      const pending = rows.filter({ hasText: filingTask.name });
      const row = rows.filter({ hasText: exempt.name });
      const basis = pending.locator("summary");
      await expect(basis).toBeVisible();
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.screenshot({ path: info.outputPath("density.png"), fullPage: true });
      const heights = await rows.evaluateAll(elements => elements.map(element => Math.max(...Array.from(
        element.querySelectorAll('td'), cell => cell.getBoundingClientRect().height,
      ))));
      await info.attach("row-heights", { body: JSON.stringify(heights), contentType: "application/json" });
      if (width === 1440) {
        await expect.soft(rows).toHaveCount(2);
        expect.soft(heights[0]).toBeLessThanOrEqual(65);
        expect.soft(heights[1]).toBeLessThanOrEqual(137);
        const event = pending.getByRole("cell", { name: `${t("statutory.NPS")} · ${t("statutory.ACQUIRE")}`, exact: true });
        const eventLines = await event.evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size;
        });
        expect.soft(eventLines).toBeLessThanOrEqual(2);
        const reason = await row.evaluate((element, text) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            if (walker.currentNode.textContent?.trim() !== text) continue;
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            return { lines: range.getClientRects().length, top: range.getBoundingClientRect().top };
          }
          throw new Error("Missing filing reason");
        }, t("statutory.OTHER_LEGAL_GROUND"));
        expect.soft(reason.lines).toBeLessThanOrEqual(2);
        const status = (await row.getByText(t("statutory.notApplicable"), { exact: true }).boundingBox())!;
        expect.soft(reason.top).toBeGreaterThanOrEqual(status.y + status.height - 1);
      }
      const marker = () => basis.evaluate(element => {
        const style = getComputedStyle(element);
        return { display: style.display, type: style.listStyleType };
      });
      expect.soft(await marker()).toEqual({ display: "list-item", type: "disclosure-closed" });
      await basis.click();
      expect.soft(await marker()).toEqual({ display: "list-item", type: "disclosure-open" });
      await fits(page, `filing evidence ${width} ${theme}`);
      await expectAxe(page, `filing evidence ${width} ${theme}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const sameEmployee of [false, true]) test(`filing actions remain reachable after searching ${sameEmployee ? "one employee’s filings" : "the filing list"} @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await mockFilings(page);
  const tasks = Array.from({ length: 30 }, (_, index) => ({
    ...filingTask, event_id: id(8400 + index), employee_id: id(8500 + index), name: sameEmployee ? "신고직원" : `신고직원${index}`,
    employee_number: sameEmployee ? "FILING-0" : `FILING-${index}`, basis: { ...filingTask.basis!, applicability_citations: Array(3).fill(filingTask.basis!.citation) },
  }));
  const target = { ...tasks.at(-1)!, kind: "LOSE" };
  tasks[tasks.length - 1] = target;
  const searches: string[] = [];
  await mockRoute(page, "get", "/api/v1/statutory/insurance-filings", request => {
    const search = new URL(request.url()).searchParams.get("search") ?? "";
    searches.push(search);
    const items = tasks.filter(task => !search || task.employee_number === search);
    return { status: 200, json: { items, total: items.length, pending: items.length, next: null } };
  });
  try {
    await page.goto("/statutory");
    const grid = page.getByRole("table", { name: t("statutory.insurance"), exact: true });
    await expect(grid).toContainText(tasks[0]!.name);
    await expect(grid.getByRole("cell", { name: `${t("statutory.NPS")} · ${t("statutory.LOSE")}`, exact: true })).toBeAttached();
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await filingRow(page, t("statutory.NPS"), t("statutory.LOSE"), target.employee_number!);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: t("statutory.record"), exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(target.name);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    expect(searches).toContain(target.employee_number);
    await expect(page.getByRole("searchbox", { name: t("statutory.search") })).toHaveValue(target.employee_number!);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const width of [1280, 1440]) test(`closing filing basis restores the next row at ${width}px @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await mockFilings(page);
  await mockRoute(page, "get", "/api/v1/statutory/insurance-filings", {
    status: 200, json: { items: [filingTask, { ...filingTask, event_id: id(8600), name: "다음 신고직원" }], total: 2, pending: 2, next: null },
  });
  try {
    await page.goto("/statutory");
    const table = page.getByRole("table", { name: t("statutory.insurance"), exact: true }).or(page.getByRole("grid", { name: t("statutory.insurance"), exact: true }));
    const next = table.getByRole("row").filter({ hasText: "다음 신고직원" });
    await expect(next).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    const top = () => next.evaluate(el => el.getBoundingClientRect().top + window.scrollY);
    const before = await top();
    const basis = table.getByText(t("statutory.basis"), { exact: true }).first();
    await basis.click();
    await expect.poll(top).toBeGreaterThan(before);
    await basis.click();
    await expect.poll(top).toBeCloseTo(before, 0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("mouse wheel reaches all 40 filings with a tall tail @ui-state", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 580 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await mockFilings(page);
  const tasks = Array.from({ length: 40 }, (_, index) => ({
    ...filingTask, event_id: id(8700 + index), name: `신고직원${index}`, employee_number: `SW-${index}`,
    opens_in_days: index < 30 ? 0 : 30, opens_on: index < 30 ? "2026-11-05" : "2026-12-01",
    basis: index < 30 ? filingTask.basis : { ...filingTask.basis!, applicability_citations: Array.from({ length: 3 }, (_, citation) => ({
      ...filingTask.basis!.citation, article: `제${citation + 1}조`, source_url: `${filingTask.basis!.citation.source_url}?article=${citation + 1}`,
    })), penalty: { citation: filingTask.basis!.citation, delay_won: [50000, 70000, 100000], per_worker: true, cap_won: 1000000 } },
  }));
  await mockRoute(page, "get", "/api/v1/statutory/insurance-filings", {
    status: 200, json: { items: tasks, total: tasks.length, pending: tasks.length, next: null },
  });
  try {
    for (const expanded of [false, true]) {
      await page.goto("/statutory");
      const table = page.getByRole("table", { name: t("statutory.insurance"), exact: true }).or(page.getByRole("grid", { name: t("statutory.insurance"), exact: true }));
      const rows = table.getByRole("row").filter({ hasText: t("statutory.ACQUIRE") });
      await expect(rows).toHaveCount(40);
      await page.evaluate(async () => { await document.fonts.ready; });
      if (expanded) await table.getByText(t("statutory.basis"), { exact: true }).first().click();
      await table.getByText(tasks[0]!.name, { exact: true }).hover();
      for (let step = 0; step < 40; step++) {
        await page.mouse.wheel(0, 500);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      const last = rows.filter({ hasText: tasks.at(-1)!.name });
      await expect(last).toBeAttached();
      await expect(last).toBeInViewport();
      await expect(last.getByRole("button", { name: t("statutory.record"), exact: true })).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`filings-end-${expanded ? "expanded" : "collapsed"}.png`), fullPage: true });
    }
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
