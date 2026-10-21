import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonDayGrid, type Cell, type Range } from "./person-day-grid";
import classes from "./person-day-grid.module.css";

type R = { id: string; name: string; v: string[] };
const yoon: R = { id: "a", name: "윤하준", v: ["8", "", "x"] };
const hwang: R = { id: "b", name: "황정우", v: ["", "7:48-", ""] };
const han: R = { id: "c", name: "한지민", v: ["", "", ""] };

const html = (rows: R[], range: Range | null, editing: { value: string; cell: Cell } | null = null, groupOf?: (r: R) => string) =>
  renderToStaticMarkup(
    <PersonDayGrid<R>
      label="10월"
      total={86}
      rows={rows}
      rowKey={(r) => r.id}
      groupOf={groupOf}
      lead={[{ key: "n", header: "성명", cell: (r) => r.name, width: "name" }]}
      days={[1, 2, 3].map((d) => ({ key: String(d), label: d, sub: "", tone: d === 3 ? "holiday" : undefined }))}
      tail={[{ key: "t", header: "합계", cell: () => "8:00", width: "total" }]}
      cell={(r, d) => r.v[d]}
      look={(r, d) => (r.id === "b" && d === 1 ? "refused" : undefined)}
      describe={(r, d) => `${r.name} ${d + 1}일`}
      range={range}
      onRange={() => undefined}
      editing={editing}
      onEdit={() => undefined}
      onCommit={() => undefined}
      onKey={() => false}
      rowHeight={32}
    />,
  );
/** The `<tr>` of a person, by their name in the lead column. */
const rowOf = (h: string, name: string) => h.split("<tr").find((tr) => tr.includes(`>${name}</th>`)) ?? "";

test("a grid with the server's row count, row indexes, the selected range and the focused cell", () => {
  const h = html([yoon, hwang], { anchor: { row: "a", col: "1" }, focus: { row: "b", col: "2" } });
  expect(h).toContain('role="grid"');
  expect(h).toContain('aria-rowcount="87"');
  expect(h).toContain('aria-rowindex="3"');
  expect((h.match(/<td[^>]*aria-selected="true"/g) ?? []).length).toBe(4);
  expect(h).toContain('data-look="refused"');
  expect(h).toMatch(/aria-activedescendant="[^"]+-r1-c1"/);
  expect(h).toContain("합계");
});

// Regression (wrong-person entry): the open editor and the focus were drawn at a row index, so a re-sort, a live
// insert above or a removal while typing put the input, and then its value, in another person's row.
test("the open editor and the focus stay in their person's row through a reorder, an insert above and a filter", () => {
  const typing = { value: "9-18", cell: { row: "a", col: "2" } };
  const range = { anchor: typing.cell, focus: typing.cell };
  for (const rows of [[yoon, hwang], [hwang, yoon], [han, yoon, hwang], [hwang, han, yoon]]) {
    const h = html(rows, range, typing);
    expect(rowOf(h, "윤하준")).toContain('aria-label="윤하준 2일" value="9-18"');
    expect(rowOf(h, "윤하준")).toContain("data-focus");
    for (const other of ["황정우", "한지민"]) {
      expect(rowOf(h, other)).not.toContain("<input");
      expect(rowOf(h, other)).not.toContain("data-focus");
    }
  }
  // Filtered out or removed: nobody else gets the input, the focus or the active descendant.
  const gone = html([hwang, han], range, typing);
  expect(gone).not.toContain("<input");
  expect(gone).not.toContain("data-focus");
  expect(gone).not.toContain("aria-activedescendant");
});

test("nothing selected draws no focus and no selection", () => {
  const h = html([yoon, hwang], null);
  expect(h).not.toContain("data-focus");
  expect(h).not.toContain('aria-selected="true"');
});

test("refused outlines and group borders draw resolved 2px solid cues with >=3:1 contrast in both themes", async () => {
  const css = readFileSync(new URL("./person-day-grid.module.css", import.meta.url), "utf8");
  const tokens = readFileSync(new URL("../../../../../packages/tokens/tokens.css", import.meta.url), "utf8");
  // Later in the sheet than the focus ring, so a focused refused cell still shows its refusal.
  expect(css.indexOf('.cell[data-look="refused"]')).toBeGreaterThan(css.indexOf(".cell[data-focus]"));
  // Vitest stubs CSS modules; match the real stylesheet to the rendered class names.
  const scoped = css.replace(/\.([a-zA-Z][\w-]*)/g, (selector, name: string) => classes[name] ? `.${classes[name]}` : selector);
  const luminance = (color: string) => {
    const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map((v) => Number(v) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // The Ubuntu CI runner provides Chrome without installing Playwright's bundled browser.
  const browser = await chromium.launch({ channel: existsSync(chromium.executablePath()) ? "chromium" : "chrome" });
  try {
    const page = await browser.newPage();
    const focus = { row: "b", col: "2" };
    await page.setContent(`<style>${tokens}\n${scoped}\nbody { background: var(--surface); }</style>${html([yoon, hwang, han], { anchor: focus, focus }, null, (r) => r.id === "c" ? "B" : "A")}`);
    const cell = page.locator('td[data-look="refused"]');
    expect(await cell.count()).toBe(1);
    for (const theme of ["light", "dark"]) {
      for (const state of ["default", "holiday", "rest", "selected-focus"]) {
        const drawn = await cell.evaluate((el, options) => {
          document.documentElement.dataset.theme = options.theme;
          el.setAttribute("data-tone", options.state);
          el.setAttribute("aria-selected", String(options.state === "selected-focus"));
          el.toggleAttribute("data-focus", options.state === "selected-focus");
          const style = getComputedStyle(el);
          let background = style.backgroundColor;
          for (let parent = el.parentElement; background === "rgba(0, 0, 0, 0)" && parent; parent = parent.parentElement)
            background = getComputedStyle(parent).backgroundColor;
          return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor, background };
        }, { theme, state });
        const context = `${theme} ${state}: ${JSON.stringify(drawn)}`;
        expect(drawn.width, context).toBe("2px");
        expect(drawn.style, context).toBe("solid");
        expect(drawn.color, context).toMatch(/^rgb\(/);
        expect(drawn.background, context).toMatch(/^rgb\(/);
        const [a, b] = [luminance(drawn.color), luminance(drawn.background)];
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), context).toBeGreaterThanOrEqual(3);
      }
      const borders = await page.locator("tr[data-group] > *").evaluateAll((cells) => cells.map((el) => {
        const style = getComputedStyle(el);
        return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor, surface: getComputedStyle(document.body).backgroundColor };
      }));
      expect(borders).toHaveLength(10);
      for (const border of borders) {
        const context = `${theme} group border: ${JSON.stringify(border)}`;
        expect(border.width, context).toBe("2px");
        expect(border.style, context).toBe("solid");
        expect(border.color, context).toMatch(/^rgb\(/);
        expect(border.surface, context).toMatch(/^rgb\(/);
        const [a, b] = [luminance(border.color), luminance(border.surface)];
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), context).toBeGreaterThanOrEqual(3);
      }
    }
  } finally {
    await browser.close();
  }
});
