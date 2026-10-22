// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { bootKo } from "../../../../../../packages/i18n/src/catalogs/boot";

const unicode = `${bootKo["app.name"]} 😀`;

async function mount(page: Page, bounded = false, variant = "table") {
  // Mount just this entry through the real dev route; unrelated galleries can open body portals.
  await page.route("**/src/gallery/gallery.tsx", (route) => route.fulfill({
    contentType: "text/javascript",
    body: 'export { default as Gallery } from "/src/features/people/ui/grid-table.gallery.tsx";',
  }));
  await page.goto(`/_gallery?grid=${variant}&bounded=${bounded}`);
  await page.locator("#gallery-grid-table").getByRole("grid").waitFor();
}

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function expectWindowAt(page: Page, row: number) {
  await expect.poll(() => page.getByRole("rowheader").allTextContents()).toContain(String(row));
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
  // Check geometry, not just DOM presence: the rendered rows must cover the viewport.
  const coverage = await page.evaluate(() => {
    const wrapper = document.getElementById("scroller")!;
    const bounds = wrapper.getBoundingClientRect();
    const top = Math.max(0, bounds.top + wrapper.clientTop);
    const bottom = Math.min(innerHeight, bounds.top + wrapper.clientTop + wrapper.clientHeight);
    const cells = [...wrapper.querySelectorAll('[role="rowheader"]')];
    const first = cells[0]!.getBoundingClientRect();
    const last = cells.at(-1)!.getBoundingClientRect();
    return { coversTop: first.top <= top, coversBottom: last.bottom >= bottom, visible: cells.some((cell) => {
      const rect = cell.getBoundingClientRect();
      return rect.bottom > top && rect.top < bottom;
    }) };
  });
  expect(coverage).toEqual({ coversTop: true, coversBottom: true, visible: true });
}

test("document scrolling renders the visible rows with the GridPage wrapper", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.scrollTo(0, 8000));
  await expectWindowAt(page, 200);
  await page.evaluate(() => window.scrollTo(0, 40000));
  await expectWindowAt(page, 1000);
});

test("focused row does not pin rendering during parent scrolling", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-0-0").focus();
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 40000; });
  await expectWindowAt(page, 1000);
  expect(await page.getByRole("grid").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.locator("#grid-1-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 8000; });
  await expectWindowAt(page, 200);
});

test("scrolling an edited cell out of view keeps its draft", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-0-2").focus();
  await page.keyboard.press("F2");
  await page.locator("#grid-0-2 input").fill("Updated draft");
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 40000; });
  await expectWindowAt(page, 1000);
  expect(await page.getByRole("grid").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(() => page.locator("#grid-0-2").textContent()).toBe("Updated draft");
});

for (const bounded of [false, true]) {
  test(`keyboard navigation reaches row 2000 (${bounded ? "parent" : "document"} scrolling)`, async ({ page }) => {
    await mount(page, bounded);
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

test("Tab and navigation on a filtered-empty grid do not throw", async ({ page }) => {
  await mount(page);
  await page.locator("#grid-0-0").focus();
  const activeChanges = await page.locator("#after").getAttribute("data-active-changes");
  await page.locator("#filter-empty").click();
  expect(await page.getByRole("rowheader").count()).toBe(0);
  await page.getByRole("grid").focus();
  for (const key of ["ArrowDown", "Control+End", "Enter", "F2", "Delete", "F8", "Tab"]) await page.keyboard.press(key);
  expect(await page.locator("#after").evaluate((el) => el === document.activeElement)).toBe(true);
  expect(await page.locator("#after").getAttribute("data-active")).toBe('{"r":0,"c":0}');
  expect(await page.locator("#after").getAttribute("data-active-changes")).toBe(activeChanges);
});

test("End and Home stay in the current row", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-1-0").click();
  for (const [key, col] of [["End", 2], ["Home", 0]] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe(`grid-1-${col}`);
  }
});

test("virtual rows expose their absolute accessible positions", async ({ page }) => {
  await mount(page, true);
  expect(await page.getByRole("row").first().getAttribute("aria-rowindex")).toBe("1");
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+End");
  await expect.poll(() => page.locator("#grid-1999-2").locator("..").getAttribute("aria-rowindex")).toBe("2001");
});

for (const key of ["F2", "Enter", "typing"]) {
  test(`${key} at the grid tab stop accepts Unicode text`, async ({ page }) => {
    await mount(page, true);
    await page.locator("#filter-empty").focus();
    await page.keyboard.press("Tab");
    if (key !== "typing") await page.keyboard.press(key);
    await expect.poll(() => page.locator("#grid-0-0 input").count()).toBe(1);
    await page.keyboard.insertText(unicode);
    await page.keyboard.press("Enter");
    expect(await page.locator("#grid-0-0").textContent()).toBe(unicode);
    expect(await page.locator("#grid-0-0").getAttribute("data-editing")).toBeNull();
    await expect.poll(() => page.locator("#grid-1-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  });
}

test("ArrowDown preserves focus across the render boundary", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-0-2").click();
  for (let i = 0; i < 70; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-70-2");
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});

for (const bounded of [false, true]) {
  test(`keyboard navigation reveals clipped columns (${bounded ? "parent" : "document"} scrolling)`, async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await mount(page, bounded);
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

test("Shift+Tab leaves the grid's single tab stop", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-0-0").focus();
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.closest('[role="grid"]'))).toBeNull();
  expect(await page.locator("#filter-empty").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.locator("#after").evaluate((el) => el === document.activeElement)).toBe(true);
});

test("density changes keep virtual spacers aligned with rows", async ({ page }) => {
  await mount(page, true);
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
    await expectWindowAt(page, 1000);
    await page.getByRole("grid").focus();
    await page.keyboard.press("Control+Home");
    await expect.poll(() => page.locator("#grid-0-0 input").evaluate((el) => el === document.activeElement)).toBe(true);
  }
});

test("GridPage Paste focuses row one after it unmounts", async ({ page }) => {
  await mount(page, true, "page");
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

test("GridPage First error reaches an unmounted stale_record refusal", async ({ page }) => {
  await page.route("**/api/v1/employees/corrections/bulk/preview", (route) => route.fulfill({ json: {
    preview_id: "preview-test", preview_digest: "digest-test", step_up_required: false,
    counts: { selected: 1, change: 0, pending: 0, unchanged: 0, refused: 1 },
    rows: [{ employee_id: "emp-1000", outcome: "REFUSED", fields: [], code: "stale_record", refusals: [{ field: "job", code: "stale_record", message: "Record changed" }] }],
  } }));
  await mount(page, true, "page");
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
  const errorsFilter = page.getByRole("button", { name: /^Errors/ });
  await errorsFilter.click();
  await page.getByRole("button", { name: "Fix errors first" }).click();
  await expect(errorsFilter).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#grid-0-2 input")).toBeFocused();
  await expect(page.getByRole("rowheader")).toHaveCount(1);
});

test("GridPage keeps the last focused cell above the footer and its header in view", async ({ page }) => {
  await mount(page, true, "page");
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+End");
  await expect.poll(() => page.locator("#grid-1999-2 input").evaluate((el) => el === document.activeElement)).toBe(true);
  const bounds = await page.locator("#grid-1999-2").evaluate((el) => {
    const cell = el.getBoundingClientRect();
    const bar = document.querySelector('#gallery-grid-table footer')!.getBoundingClientRect();
    const header = document.querySelector('#gallery-grid-table [role="columnheader"]')!.getBoundingClientRect();
    return { cellBottom: cell.bottom, cellTop: cell.top, barTop: bar.top, barBottom: bar.bottom, headerTop: header.top, headerBottom: header.bottom };
  });
  expect(bounds.cellBottom).toBeLessThanOrEqual(bounds.barTop);
  expect(bounds.barBottom).toBeLessThanOrEqual(800);
  expect(bounds.headerTop).toBeGreaterThanOrEqual(0);
  expect(bounds.headerBottom).toBeLessThanOrEqual(bounds.cellTop);
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});


test("F8 explains the error at row 1000 inside the scroller", async ({ page }) => {
  await mount(page, true);
  await page.getByRole("grid").focus();
  await page.keyboard.press("F8");
  await expect(page.locator("#grid-999-2 input")).toBeFocused();
  const tip = page.locator('#gallery-grid-table [role="status"]');
  await expect(tip).toContainText("1,000");
  await expect.poll(() => tip.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    const scroller = document.getElementById("scroller")!.getBoundingClientRect();
    return bounds.top >= scroller.top && bounds.bottom <= scroller.bottom && bounds.left >= scroller.left && bounds.right <= scroller.right;
  })).toBe(true);
});

test("ArrowUp keeps the active row below the sticky column headers", async ({ page }) => {
  await mount(page, true, "page");
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+End");
  await expect(page.locator("#grid-1999-2 input")).toBeFocused();
  for (let row = 1998; row >= 1960; row--) {
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(`#grid-${row}-2 input`)).toBeFocused();
    await expect.poll(() => page.locator(`#grid-${row}-2`).evaluate((el) => {
      const header = document.querySelector('#gallery-grid-table [role="columnheader"]')!.getBoundingClientRect();
      return el.getBoundingClientRect().top >= header.bottom;
    })).toBe(true);
  }
});

test("PageDown and PageUp follow the measured viewport when it resizes", async ({ page }) => {
  await mount(page, true);
  for (const height of [1600, 800]) {
    await page.setViewportSize({ width: 1280, height });
    await page.getByRole("grid").focus();
    await page.keyboard.press("Control+Home");
    await expect(page.locator("#grid-0-0 input")).toBeFocused();
    const step = await page.locator("#scroller").evaluate((el) => {
      const bounds = el.getBoundingClientRect(), style = getComputedStyle(el);
      const top = Math.max(0, bounds.top + el.clientTop) + parseFloat(style.scrollPaddingTop);
      const bottom = Math.min(innerHeight, bounds.top + el.clientTop + el.clientHeight) - parseFloat(style.scrollPaddingBottom);
      const rowHeight = parseFloat(getComputedStyle(el.querySelector('[role="grid"]')!).getPropertyValue("--row-h"));
      return Math.max(1, Math.max(25, Math.ceil((bottom - top) / rowHeight) + 1) - 1);
    });
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#grid-1-0 input")).toBeFocused();
    await page.keyboard.press("PageDown");
    await expect(page.locator(`#grid-${step + 1}-0 input`)).toBeFocused();
    await page.keyboard.press("PageUp");
    await expect(page.locator("#grid-1-0 input")).toBeFocused();
  }
});
