// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.afterEach(() => i18n.set("ko"));

const values = [
  { name: "short", title: "조직 개편", secondary: "인사" },
  { name: "Latin", title: "ABCDEFGHIJKLMNOPQRST", secondary: "ABCDEFGHIJKLMNOPQRST" },
  { name: "Korean", title: "가".repeat(30), secondary: "나".repeat(30) },
];

for (const width of [1024, 1280, 1440]) for (const preview of [false, true])
  for (const locale of ["ko", "en"] as const) for (const value of values) {
    test(`approval column invariants: ${width}px preview=${preview} ${locale} ${value.name}`, async ({ page }) => {
      await loadCatalog(locale);
      i18n.set(locale);
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(lang => localStorage.setItem("console.locale", lang), locale);
      const mock = await mockScreen(page, screens[0], "empty");
      const item = {
        id: "approval-layout", box: "pending", title: value.title, summary: value.title,
        document_no: value.secondary, source: { key: "org_change", label: value.secondary },
        status: { key: "IN_APPROVAL" }, requester: { id: "requester", name: value.secondary },
        requested_at: "2026-11-03T01:00:00Z", due_at: null, facts: [],
        route: [{ id: "current", role_key: "legal", assignee: value.secondary, state: "current" }],
        viewer: { kind: "org_change", id: "change-layout" },
      };
      await page.route(url => url.pathname === "/api/v1/approvals", route => route.fulfill({ json: {
        items: [item], focused: null, next_cursor: null, sources: [],
        counts: { pending: 1, upcoming: 0, requested: 0, reference: 0, completed: 0 },
      } }));
      await page.goto("/approvals");
      const grid = page.getByRole("grid", { name: t("approvals.list"), exact: true });
      const row = grid.getByRole("row", { name: new RegExp(value.title) });
      await expect(row).toBeVisible();
      if (preview) {
        await row.click();
        await expect(page.locator("[data-side-panel]")).toBeVisible();
      }
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
          containerWidth: container.clientWidth,
          overflows: [card, card.firstElementChild!, container, table].map(el => el.scrollWidth - el.clientWidth),
          tableRight: bounds(table).right, cardRight: bounds(card).right,
          titleWidth: bounds(title).width,
          titleMinimum: getComputedStyle(title).minWidth,
          // --rail-w is the existing 220px size token reserved for the document title.
          minimum: parseFloat(getComputedStyle(title).getPropertyValue("--rail-w")),
          statusFits: range.getBoundingClientRect().right <= bounds(status).right
            && bounds(statusText).right <= bounds(status).right
            && bounds(status).right <= bounds(card).right,
          statusHeaderFits: headers.at(-1)!.scrollWidth <= headers.at(-1)!.clientWidth,
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
      expect(metrics.tableRight).toBeLessThanOrEqual(metrics.cardRight);
      expect(metrics.statusFits, "entire status chip fits inside the card").toBe(true);
      expect(metrics.statusHeaderFits).toBe(true);
      expect(metrics.titleWidth).toBeGreaterThanOrEqual(metrics.minimum);
      expect(metrics.titleMinimum, "title retains an explicit token minimum").toContain(`${metrics.minimum}px`);
      expect(metrics.secondary).toHaveLength(5);
      for (const cell of metrics.secondary) {
        const visible = metrics.containerWidth > ([0, 3].includes(cell.index) ? 640 : 1100);
        expect(cell.visible, `column ${cell.index} follows its container budget`).toBe(visible);
        expect(cell.headerVisible).toBe(visible);
        if (!visible) continue;
        expect(cell.fullValue).toBe(cell.text);
        expect(cell.maxWidth).not.toBe("none");
        expect(cell.width).toBeLessThanOrEqual(parseFloat(cell.maxWidth));
        expect([cell.overflow, cell.ellipsis, cell.whiteSpace]).toEqual(["hidden", "ellipsis", "nowrap"]);
      }
      expect(mock.unexpected).toEqual([]);
    });
  }
