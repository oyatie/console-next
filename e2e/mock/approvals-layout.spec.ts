// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.afterEach(() => i18n.set("ko"));

const values = [
  { name: "real", title: "영업 조직 개편안", secondary: "AP-2026-001" },
  { name: "document", title: "영업 조직 개편안", secondary: "OC-2026-HR-1103-001" },
  { name: "short", title: "조직 개편", secondary: "인사" },
  { name: "Latin", title: "ABCDEFGHIJKLMNOPQRST", secondary: "ABCDEFGHIJKLMNOPQRST" },
  { name: "Korean", title: "가".repeat(30), secondary: "나".repeat(30) },
  { name: "oversized", title: "조직 개편", secondary: "나".repeat(80) },
];

for (const preview of [false, true])
  for (const locale of ["ko", "en"] as const) for (const value of values) {
    test(`approval column invariants: preview=${preview} ${locale} ${value.name}`, async ({ page }) => {
      await loadCatalog(locale);
      i18n.set(locale);
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.addInitScript(lang => localStorage.setItem("console.locale", lang), locale);
      const mock = await mockScreen(page, screens[0], "empty");
      const item = {
        id: "approval-layout", box: "pending", title: value.title, summary: value.title,
        document_no: value.secondary, source: { key: "org_change", label: ["real", "document"].includes(value.name) ? "조직 변경" : value.secondary },
        status: { key: "IN_APPROVAL" }, requester: { id: "requester", name: ["real", "document"].includes(value.name) ? "김기안" : value.secondary },
        requested_at: "2026-11-03T01:00:00Z", due_at: null, facts: [],
        route: [{ id: "current", role_key: "legal", assignee: ["real", "document"].includes(value.name) ? "박결재" : value.secondary, state: "current" }],
        viewer: { kind: "org_change", id: "change-layout" },
      };
      await page.route(url => url.pathname === "/api/v1/approvals", route => route.fulfill({ json: {
        items: [item], focused: null, next_cursor: null, sources: [],
        counts: { pending: 1, upcoming: 0, requested: 0, reference: 0, completed: 0 },
      } }));
      await page.route(url => url.pathname === "/api/v1/approvals/approval-layout", route => route.fulfill({ json: {
        ...item, body: [], revision: 1, fingerprint: "sha256:approval-layout-r1", consequence: value.title, opinion_max: 1000, my_actions: { kind: "none" },
      } }));
      await page.goto("/approvals");
      const grid = page.getByRole("grid", { name: t("approvals.list"), exact: true });
      const row = grid.getByRole("row", { name: new RegExp(value.title) });
      await expect(row).toBeVisible();
      if (preview) {
        await row.click();
        await expect(page.getByRole("complementary", { name: t("approvals.document.title"), exact: true })).toBeVisible();
      }
      // The data and preview stay fixed; exercise every container breakpoint on the same render.
      for (const width of [1024, 1100, 1152, 1216, 1280, 1366, 1440, 1472, 1536, 1600, 1920]) {
        await test.step(`${width}px`, async () => {
          await page.setViewportSize({ width, height: 900 });
          const metrics = await grid.evaluate(table => {
            const card = table.closest("section")!;
            const container = table.parentElement!.parentElement!;
            const cells = Array.from(table.querySelectorAll<HTMLElement>("tbody tr:first-child td"));
            const headers = Array.from(table.querySelectorAll<HTMLElement>("thead th"));
            const title = cells.find(cell => cell.dataset.card === "title")!.firstElementChild as HTMLElement;
            const status = cells.find(cell => cell.dataset.card === "status")!;
            const statusText = status.firstElementChild as HTMLElement;
            const bounds = (el: Element) => el.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(statusText);
            return {
              // Beside an open document a narrow list falls back to the card layout, which has no column tracks.
              cards: getComputedStyle(table).display !== "grid",
              containerWidth: container.clientWidth,
              // Measure intrinsic values independently of the production cap and hide conditions.
              naturalWidths: cells.map((cell, index) => {
                const natural = (el: HTMLElement) => {
                  const clone = el.cloneNode(true) as HTMLElement;
                  const style = getComputedStyle(el);
                  clone.style.cssText = "display:block;position:fixed;width:max-content;min-width:0;max-width:none;white-space:nowrap;visibility:hidden";
                  clone.style.font = style.font;
                  clone.style.letterSpacing = style.letterSpacing;
                  clone.style.paddingLeft = style.paddingLeft;
                  clone.style.paddingRight = style.paddingRight;
                  document.body.append(clone);
                  const width = clone.getBoundingClientRect().width;
                  clone.remove();
                  return width;
                };
                const style = getComputedStyle(cell);
                const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
                return Math.max(natural(headers[index]!), natural(cell.firstElementChild as HTMLElement ?? cell) + (cell.firstElementChild ? padding : 0));
              }),
              values: cells.map(cell => {
                const inner = cell.firstElementChild as HTMLElement ?? cell;
                return { visible: getComputedStyle(cell).display !== "none", clipped: inner.scrollWidth > inner.clientWidth };
              }),
              overflows: [card, card.firstElementChild!, container, table].map(el => el.scrollWidth - el.clientWidth),
              tableRight: bounds(table).right, cardRight: bounds(card).right,
              titleWidth: bounds(title).width,
              titlePadding: parseFloat(getComputedStyle(title.parentElement!).paddingLeft) + parseFloat(getComputedStyle(title.parentElement!).paddingRight),
              titleMinimum: getComputedStyle(title).minWidth,
              minimum: 13.75 * parseFloat(getComputedStyle(document.documentElement).fontSize),
              statusFits: range.getBoundingClientRect().right <= bounds(status).right
                && bounds(statusText).right <= bounds(status).right
                && bounds(status).right <= bounds(card).right,
              statusHeaderFits: headers.at(-1)!.scrollWidth <= headers.at(-1)!.clientWidth,
              // Distance from each visible cell's text centre to the cell's centre.
              textOffsets: [...headers, ...cells].filter(el => getComputedStyle(el).display !== "none").map(el => {
                const text = document.createRange();
                text.selectNodeContents(el);
                const box = text.getBoundingClientRect(), cell = bounds(el);
                return Math.abs((box.top + box.bottom - cell.top - cell.bottom) / 2);
              }),
              secondary: cells.flatMap((cell, index) => {
                if (cell.dataset.card !== "fact") return [];
                const text = cell.firstElementChild as HTMLElement ?? cell;
                const style = getComputedStyle(text);
                const padding = text === cell ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0;
                return [{ index, visible: getComputedStyle(cell).display !== "none",
                  headerVisible: getComputedStyle(headers[index]!).display !== "none",
                  maxWidth: style.maxWidth, width: bounds(text).width - padding,
                  overflow: style.overflow, ellipsis: style.textOverflow, whiteSpace: style.whiteSpace,
                  fullValue: text.title, text: cell.textContent,
                }];
              }),
            };
          });
          expect(metrics.overflows, "table and every enclosing surface fit without scrolling").toEqual([0, 0, 0, 0]);
          if (metrics.cards) return void expect(preview && width < 1280, "only a list squeezed by the document column uses cards").toBe(true);
          expect(metrics.tableRight).toBeLessThanOrEqual(metrics.cardRight);
          expect(metrics.statusFits, "entire status chip fits inside the card").toBe(true);
          expect(metrics.statusHeaderFits).toBe(true);
          for (const offset of metrics.textOffsets) expect(offset, "cell text is vertically centred").toBeLessThanOrEqual(2);
          expect(metrics.secondary).toHaveLength(5);
          const minimum = metrics.minimum;
          // Whole-value checks use the natural title width when it is shorter than the title floor.
          const visibleMetadataFit = metrics.naturalWidths.reduce((sum, size, index) => sum + (metrics.values[index]!.visible ? index === 1 ? Math.min(size, minimum + metrics.titlePadding) : size : 0), 0) <= metrics.containerWidth;
          const visibleTracksFit = metrics.naturalWidths.reduce((sum, size, index) => sum + (metrics.values[index]!.visible ? index === 1 ? minimum + metrics.titlePadding : size : 0), 0) <= metrics.containerWidth;
          const visibleContentFit = metrics.naturalWidths.reduce((sum, size, index) => sum + (metrics.values[index]!.visible ? size : 0), 0) <= metrics.containerWidth;
          if (visibleMetadataFit) for (const [index, cell] of metrics.values.entries()) {
            if (cell.visible && ([0, 5, 6].includes(index) || (visibleTracksFit && (index !== 1 || visibleContentFit)))) expect(cell.clipped, `inner value ${index} is whole when there is room`).toBe(false);
          }
          for (const index of [0, 5]) {
            if (metrics.values[index]!.visible && (index === 5 || ["real", "document", "short"].includes(value.name))) {
              expect(metrics.values[index]!.clipped, `identity/date ${index} stays whole`).toBe(false);
            }
          }
          if ((!preview && width >= 1216) || (preview && width === 1920)) {
            expect(metrics.values.every(cell => cell.visible), "desktop list retains all seven columns").toBe(true);
          }
          if ((!preview && width <= 1152) || (preview && width >= 1472 && width <= 1600)) {
            expect(metrics.values.map(cell => cell.visible), "compact lists keep identity, title, route and status").toEqual([true, true, false, true, false, false, true]);
          }
          for (const cell of metrics.secondary) {
            expect(cell.headerVisible).toBe(cell.visible);
            // The route cell is a list of chips; its tooltip names every step, which the chips abbreviate.
            if (cell.visible && cell.index !== 3) expect(cell.fullValue).toBe(cell.text);
          }
          expect(metrics.titleWidth).toBeGreaterThanOrEqual(metrics.minimum);
          expect(parseFloat(metrics.titleMinimum)).toBe(metrics.minimum);
        });
      }
      expect(mock.unexpected).toEqual([]);
    });
  }
