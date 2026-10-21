// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GridTable, type GridRow } from "./grid-table";
import { page, server, setupGridFixture, mount, expectWindowAt } from "./grid-table.test-fixture";
import type { GridField } from "../domain/grid";

const columns: readonly GridField[] = [
  { key: "sex", kind: "sex", cls: "now" },
  { key: "address", kind: "address", cls: "now" },
  { key: "job", kind: "text", cls: "now" },
];
const rows2000: readonly GridRow[] = Array.from({ length: 2000 }, (_, i) => ({
  id: `emp-${i + 1}`, number: String(i + 1).padStart(4, "0"), name: `Person ${i + 1} 직원 😀`,
  current: ["MALE", "Seoul", "Developer"], typed: [undefined, undefined, undefined],
  cells: [{ keep: true }, { keep: true }, { keep: true }],
}));

setupGridFixture(rows2000, columns);

test("component test at 2,000 rows: rendered row elements <= visible + overscan", async () => {
  const markup = renderToStaticMarkup(<GridTable rows={rows2000} columns={columns} label="People grid"
    onCell={() => undefined} statusOf={() => ({ tone: "same", text: "Same" })}
    fieldLabel={(f) => f.key} suggestionOf={() => undefined} />);
  expect((markup.match(/role="row"/g) ?? []).length - 1).toBeLessThanOrEqual(25 + 10);
  await mount();
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});

test("document scrolling renders the visible rows with the GridPage wrapper", async () => {
  await mount();
  await page.evaluate(() => window.scrollTo(0, 8000));
  await expectWindowAt(200);
  await page.evaluate(() => window.scrollTo(0, 40000));
  await expectWindowAt(1000);
});

test("focused row does not pin rendering during parent scrolling", async () => {
  await mount(true);
  await page.locator("#grid-0-0").focus();
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 40000; });
  await expectWindowAt(1000);
  expect(await page.getByRole("grid").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.locator("#grid-1-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 8000; });
  await expectWindowAt(200);
});

test("scrolling an edited cell out of view keeps its draft", async () => {
  await mount(true);
  await page.locator("#grid-0-2").focus();
  await page.keyboard.press("F2");
  await page.locator("#grid-0-2 input").fill("Updated draft");
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 40000; });
  await expectWindowAt(1000);
  expect(await page.getByRole("grid").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(() => page.locator("#grid-0-2").textContent()).toBe("Updated draft");
});

for (const bounded of [false, true]) {
  test(`keyboard navigation reaches row 2000 (${bounded ? "parent" : "document"} scrolling)`, async () => {
    await mount(bounded);
    await page.getByRole("grid").focus();
    await page.keyboard.press("Control+End");
    await expect.poll(() => page.locator("#grid-1999-2 input").evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
    expect(await page.locator("#grid-0-0").count()).toBe(0);
    await expect.poll(() => page.locator("#grid-1999-2").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const wrapper = document.getElementById("scroller")!.getBoundingClientRect();
      return rect.bottom <= Math.min(innerHeight, wrapper.bottom) && rect.top >= Math.max(0, wrapper.top);
    })).toBe(true);
    await page.keyboard.press("Control+Home");
    await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.locator("#grid-1999-0").count()).toBe(0);
  });
}

test("keyboard navigation moves row by row and page by page", async () => {
  await mount(true);
  await page.locator("#grid-0-0").focus();
  for (const [key, row] of [["ArrowDown", 1], ["PageDown", 26], ["PageUp", 1]] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => page.locator(`#grid-${row}-0 input`).evaluate((el) => el === document.activeElement)).toBe(true);
  }
});

test("Tab and navigation on a filtered-empty grid do not throw", async () => {
  await mount();
  await page.locator("#grid-0-0").focus();
  const activeChanges = await page.locator("#after").getAttribute("data-active-changes");
  await page.getByRole("button", { name: "Filter empty" }).click();
  expect(await page.getByRole("rowheader").count()).toBe(0);
  await page.getByRole("grid").focus();
  for (const key of ["ArrowDown", "Control+End", "Enter", "F2", "Delete", "F8", "Tab"]) await page.keyboard.press(key);
  expect(await page.locator("#after").evaluate((el) => el === document.activeElement)).toBe(true);
  expect(await page.locator("#after").getAttribute("data-active")).toBe('{"r":0,"c":0}');
  expect(await page.locator("#after").getAttribute("data-active-changes")).toBe(activeChanges);
});

test("End and Home stay in the current row", async () => {
  await mount(true);
  await page.locator("#grid-1-0").click();
  for (const [key, col] of [["End", 2], ["Home", 0]] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe(`grid-1-${col}`);
  }
});

test("virtual rows expose their absolute accessible positions", async () => {
  await mount(true);
  expect(await page.getByRole("row").first().getAttribute("aria-rowindex")).toBe("1");
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+End");
  await expect.poll(() => page.locator("#grid-1999-2").locator("..").getAttribute("aria-rowindex")).toBe("2001");
});

for (const key of ["F2", "Enter", "typing"]) {
  test(`${key} at the grid tab stop accepts Unicode text`, async () => {
    await mount(true);
    await page.getByRole("button", { name: "Filter empty" }).focus();
    await page.keyboard.press("Tab");
    if (key !== "typing") await page.keyboard.press(key);
    await expect.poll(() => page.locator("#grid-0-0 input").count()).toBe(1);
    await page.keyboard.insertText("직원 😀");
    await page.keyboard.press("Enter");
    expect(await page.locator("#grid-0-0").textContent()).toBe("직원 😀");
    expect(await page.locator("#grid-0-0").getAttribute("data-editing")).toBeNull();
    await expect.poll(() => page.locator("#grid-1-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  });
}

test("ArrowDown preserves focus across the render boundary", async () => {
  await mount(true);
  await page.locator("#grid-0-2").click();
  for (let i = 0; i < 70; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-70-2");
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});

for (const bounded of [false, true]) {
  test(`keyboard navigation reveals clipped columns (${bounded ? "parent" : "document"} scrolling)`, async () => {
    await page.setViewportSize({ width: 600, height: 800 });
    await mount(bounded);
    await page.locator("#grid-0-0").click();
    for (const [key, cell] of [["ArrowRight", "grid-0-1"], ["ArrowRight", "grid-0-2"], ["Home", "grid-0-0"], ["Control+End", "grid-1999-2"]] as const) {
      await page.keyboard.press(key);
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe(cell);
      await expect.poll(() => page.locator(`#${cell}`).evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const wrapper = document.getElementById("scroller")!.getBoundingClientRect();
        return rect.left >= Math.max(0, wrapper.left) && rect.right <= Math.min(innerWidth, wrapper.right);
      })).toBe(true);
    }
  });
}

test("GridPage Paste focuses row one after it unmounts", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}__grid-test?page`);
  await page.getByRole("grid").waitFor();
  await page.locator("#grid-0-0").click();
  for (let i = 0; i < 70; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-70-0");
  expect(await page.locator("#grid-0-0").count()).toBe(0);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: /^Paste/ }).click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-0-0");
  }
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});

test("GridPage First error reaches an unmounted stale_record refusal", async () => {
  await page.route("**/api/v1/employees/corrections/bulk/preview", (route) => route.fulfill({ json: {
    preview_id: "preview-test", preview_digest: "digest-test", step_up_required: false,
    counts: { selected: 1, change: 0, pending: 0, unchanged: 0, refused: 1 },
    rows: [{ employee_id: "emp-1000", outcome: "REFUSED", fields: [], code: "stale_record", refusals: [{ field: "job", code: "stale_record", message: "Record changed" }] }],
  } }));
  await page.goto(`${server.resolvedUrls!.local[0]}__grid-test?page`, { waitUntil: "domcontentloaded" });
  await page.getByRole("grid").waitFor();
  await page.locator("#grid-0-2").click();
  await page.keyboard.press("F2");
  await page.keyboard.insertText("Updated draft");
  await page.keyboard.press("Enter");
  expect(await page.locator("#grid-0-2").textContent()).toContain("Updated draft");
  expect(await page.locator("footer").getByRole("button").last().getAttribute("aria-disabled"), await page.locator("footer").innerText()).toBeNull();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Back to editing" }).click();
  expect(await page.locator("#grid-999-2").count()).toBe(0);
  await page.getByRole("button", { name: "Fix errors first" }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-999-2");
  expect(await page.locator("#grid-999-2").getAttribute("aria-invalid")).toBe("true");
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
  await page.getByRole("button", { name: /^Changed/ }).click();
  expect(await page.locator("#grid-999-2").count()).toBe(0);
  await page.getByRole("button", { name: "Fix errors first" }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-999-2");
});

test("Shift+Tab leaves the grid's single tab stop", async () => {
  await mount(true);
  await page.locator("#grid-0-0").focus();
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.closest('[role="grid"]'))).toBeNull();
  expect(await page.getByRole("button", { name: "Filter empty" }).evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.locator("#after").evaluate((el) => el === document.activeElement)).toBe(true);
});

test("density changes keep virtual spacers aligned with rows", async () => {
  await mount(true);
  for (const [density, height] of [["regular", 40], ["compact", 32], ["regular", 40]] as const) {
    await page.locator("#scroller").evaluate((el, value) => { el.setAttribute("data-density", value); }, density);
    await expect.poll(() => page.getByRole("rowheader").first().evaluate((el) => el.getBoundingClientRect().height)).toBe(height);
    await page.locator("#grid-0-0").focus();
    await page.keyboard.press("Control+End");
    await expect.poll(() => page.locator("#grid-1999-2 input").evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
    await expect.poll(() => page.locator("#grid-1999-2").evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      const wrapper = document.getElementById("scroller")!.getBoundingClientRect();
      return bounds.bottom <= wrapper.bottom && bounds.top >= wrapper.top;
    })).toBe(true);
    await page.locator("#scroller").evaluate((el, value) => { el.scrollTop = 1000 * value; }, height);
    await expectWindowAt(1000);
    await page.getByRole("grid").focus();
    await page.keyboard.press("Control+Home");
    await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  }
});

test("GridPage keeps the last focused cell above the footer and its header in view", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}__grid-test?page`);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+End");
  await expect.poll(() => page.locator("#grid-1999-2 input").evaluate((el) => el === document.activeElement)).toBe(true);
  const bounds = await page.locator("#grid-1999-2").evaluate((el) => {
    const cell = el.getBoundingClientRect();
    const bar = document.querySelector('footer')!.getBoundingClientRect();
    const header = document.querySelector('[role="columnheader"]')!.getBoundingClientRect();
    return { cellBottom: cell.bottom, cellTop: cell.top, barTop: bar.top, barBottom: bar.bottom, headerTop: header.top, headerBottom: header.bottom };
  });
  expect(bounds.cellBottom).toBeLessThanOrEqual(bounds.barTop);
  expect(bounds.barBottom).toBeLessThanOrEqual(800);
  expect(bounds.headerTop).toBeGreaterThanOrEqual(0);
  expect(bounds.headerBottom).toBeLessThanOrEqual(bounds.cellTop);
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});
