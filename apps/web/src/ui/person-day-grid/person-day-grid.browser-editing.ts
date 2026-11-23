// SPDX-License-Identifier: LicenseRef-Proprietary
// The month view's editing cases of the grid's browser test, run on its server and page: typing, keys, presses, links.
import { beforeAll, expect, test } from "vitest";
import { expect as element, type Locator, type Page } from "@playwright/test";

export type MonthView = {
  page: Page;
  /** Opens the month view, in a box of `?w=` px when the query gives one, and returns its grid. */
  month: (query?: string) => Promise<Locator>;
  dayCell: (person: number, day: number) => Locator;
  /** The active cell as "row,column", counted from 0. */
  active: () => Promise<string | undefined>;
};

/** A paste on what has the focus, read a frame later, once the page has drawn what it asked for. */
export const paste = (page: Page) => page.evaluate(() => {
  const data = new DataTransfer();
  data.setData("text/plain", "9-18");
  document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  return new Promise(done => requestAnimationFrame(() => setTimeout(done)));
});

/** Registers the cases; `view` is read once the test file's page is up. */
export function editingCases(view: () => MonthView) {
  let page: Page, month: MonthView["month"], dayCell: MonthView["dayCell"], active: MonthView["active"];
  // What the fixture prints of the drafts, and the open editor.
  let drafts: Locator, editor: Locator;
  beforeAll(() => {
    ({ page, month, dayCell, active } = view());
    drafts = page.locator("#drafts");
    editor = page.getByRole("textbox");
  });
  const FIRST = '"0001|2026-10-01":"9-18"';

  test("when an edit ends the grid has the focus again, so the next key lands on it", async () => {
    const grid = await month();
    await grid.focus();
    await page.keyboard.type("9-18");
    await element(editor).toBeFocused();
    await page.keyboard.press("Enter");
    await element(drafts).toHaveText(`{${FIRST}}`);
    await element(grid).toBeFocused();
    expect(await active()).toBe("1,0");
    // One edit is one step back: taking the focus back did not commit a second time.
    await page.keyboard.press("Control+z");
    await element(drafts).toHaveText("{}");
    await page.keyboard.press("Control+y");
    await element(drafts).toHaveText(`{${FIRST}}`);
    expect(await active()).toBe("1,0");

    await page.keyboard.press("ArrowRight");
    await expect.poll(active).toBe("1,1");
    await page.keyboard.type("x");
    await page.keyboard.press("Tab");
    await element(drafts).toHaveText(`{${FIRST},"0002|2026-10-02":"x"}`);
    await element(grid).toBeFocused();
    expect(await active()).toBe("1,2");

    await page.keyboard.type("o");
    await element(editor).toBeFocused();
    await page.keyboard.press("Escape");
    await element(editor).toHaveCount(0);
    await element(grid).toBeFocused();
    await element(drafts).toHaveText(`{${FIRST},"0002|2026-10-02":"x"}`);
    await page.keyboard.press("ArrowDown");
    await expect.poll(active).toBe("2,2");
  });

  test("Tab pressed while a syllable is still composing keeps the keyboard in the editor", async () => {
    const grid = await month();
    await grid.focus();
    await page.keyboard.type("9");
    await element(editor).toBeFocused();
    // A composition the way the browser's input-method interface starts one: the Tab arrives marked as composing.
    const ime = await page.context().newCDPSession(page);
    await ime.send("Input.imeSetComposition", { text: "h", selectionStart: 1, selectionEnd: 1 });
    await element(editor).toHaveValue("9h");
    await page.keyboard.press("Tab");
    await element(editor).toBeFocused();
    await element(drafts).toHaveText("{}");
    // The syllable is done; what is typed next goes into the editor, and a plain Tab commits and moves right.
    await ime.send("Input.insertText", { text: "x" });
    await page.keyboard.type("5");
    await element(editor).toHaveValue("9x5");
    await page.keyboard.press("Tab");
    await element(drafts).toHaveText('{"0001|2026-10-01":"9x5"}');
    await element(grid).toBeFocused();
    expect(await active()).toBe("0,1");
  });

  test("an edit opened with the pointer gives the focus to what is pressed next", async () => {
    const grid = await month();
    // A press on another cell commits and the grid has the focus (cells left of the editor's column do not move as it closes).
    await dayCell(1, 5).dblclick();
    await element(editor).toBeFocused();
    await page.keyboard.type("9-18");
    await dayCell(3, 3).click();
    await element(drafts).toHaveText('{"0001|2026-10-05":"9-18"}');
    await element(grid).toBeFocused();
    expect(await active()).toBe("2,2");
    // It has it as from any press: without the focus ring a key brings.
    expect(await grid.evaluate(el => el.matches(":focus-visible"))).toBe(false);
    await page.keyboard.press("ArrowDown");
    await expect.poll(active).toBe("3,2");
    // Opened with a double-click and closed with a key, the grid has it too.
    await dayCell(2, 2).dblclick();
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    await element(grid).toBeFocused();
    expect(await grid.evaluate(el => el.matches(":focus-visible"))).toBe(true);
    expect(await active()).toBe("2,1");
    // A press outside the grid commits and keeps the focus where the person put it.
    await dayCell(4, 4).dblclick();
    await page.keyboard.type("o");
    const outside = page.getByRole("button", { name: "Outside" });
    await outside.click();
    await element(drafts).toHaveText('{"0001|2026-10-05":"9-18","0002|2026-10-02":"x","0004|2026-10-04":"o"}');
    await element(outside).toBeFocused();
  });

  test("a press that ends an edit selects the pressed cell alone, though the closing editor moves it from under the pointer", async () => {
    const grid = await month();
    const selected = grid.locator('td[aria-selected="true"]');
    // The closing editor moves the cells in and right of its column under the pointer: below it, then right of it.
    for (const [person, day, cell, draft] of [[2, 1, "1,0", '"0002|2026-10-01":"5"'], [1, 4, "0,3", '"0001|2026-10-04":"5"']] as const) {
      await dayCell(1, 1).dblclick();
      await element(editor).toBeFocused();
      await dayCell(person, day).click();
      await element(editor).toHaveCount(0);
      await element(selected).toHaveCount(1);
      expect(await active()).toBe(cell);
      // What is typed next is that cell's.
      await page.keyboard.type("5");
      await page.keyboard.press("Enter");
      await element(drafts).toContainText(draft);
    }
    // With no editor open a press still starts a drag over a range.
    await dayCell(1, 1).hover();
    await page.mouse.down();
    await dayCell(3, 4).hover();
    await page.mouse.up();
    await element(selected).toHaveCount(12);
  });

  test("a person's name link opens with Enter, and keys pressed on it are not the grid's", async () => {
    const grid = await month();
    // A draft under the selection, which Backspace on the grid would clear.
    await dayCell(1, 1).dblclick();
    await page.keyboard.type("9-18");
    await dayCell(1, 2).click();
    await dayCell(1, 1).click();
    await element(drafts).toHaveText(`{${FIRST}}`);
    await element(grid).toBeFocused();
    await page.keyboard.press("Tab");
    const link = grid.getByRole("link", { name: "Person 1", exact: true });
    await element(link).toBeFocused();
    await page.keyboard.press("Enter");
    await element(page.locator("#search")).toHaveText("?person=00000000-0000-4000-8000-000000000001");
    await element(editor).toHaveCount(0);
    // The grid's own keys and the month view's (the day sheet, clear, the month, an edit) do nothing from the link.
    await link.focus();
    for (const key of ["p", "Backspace", "Delete", "]", "8", "F2", "ArrowDown"]) await page.keyboard.press(key);
    await element(link).toBeFocused();
    await element(editor).toHaveCount(0);
    await element(drafts).toHaveText(`{${FIRST}}`);
    await element(page.locator("#acts")).toHaveText("");
    expect(await active()).toBe("0,0");
    // The month view's chords are the page's on a control in a cell too: save, undo and redo.
    await page.keyboard.press("Control+s");
    await element(page.locator("#acts")).toHaveText("save");
    await page.keyboard.press("Control+z");
    await element(drafts).toHaveText("{}");
    await page.keyboard.press("Control+y");
    await element(drafts).toHaveText(`{${FIRST}}`);
    await element(link).toBeFocused();
    // Nor is a paste on the link the grid's: the paste preview opens for one on the grid itself.
    await paste(page);
    await element(page.getByRole("dialog")).toHaveCount(0);
    await grid.focus();
    await paste(page);
    await element(page.getByRole("dialog")).toHaveCount(1);
  });

  test("the assign button in a lead cell keeps its keys, and the save, undo and redo chords work on it", async () => {
    const grid = await month("?unscheduled");
    await grid.focus();
    await page.keyboard.type("9-18");
    await page.keyboard.press("Enter");
    await element(drafts).toHaveText(`{${FIRST}}`);
    const assign = grid.getByRole("button"), acts = page.locator("#acts");
    await assign.focus();
    for (const key of ["p", "Backspace", "Delete", "]", "8", "F2", "ArrowDown"]) await page.keyboard.press(key);
    await element(assign).toBeFocused();
    await element(editor).toHaveCount(0);
    await element(drafts).toHaveText(`{${FIRST}}`);
    await element(acts).toHaveText("");
    await page.keyboard.press("Enter");
    await element(acts).toHaveText("assign");
    await page.keyboard.press("Control+s");
    await element(acts).toHaveText("assign,save");
    await page.keyboard.press("Control+z");
    await element(drafts).toHaveText("{}");
    await page.keyboard.press("Control+y");
    await element(drafts).toHaveText(`{${FIRST}}`);
    await element(assign).toBeFocused();
  });

  test("Delete on a saved day with no draft asks to void it", async () => {
    await month();
    await dayCell(1, 2).click();
    await page.keyboard.press("Delete");
    await element(page.locator("#acts")).toHaveText("void");
  });

  test("a paste from the keyboard with the grid focused opens the paste preview, after a focus and after a press", async () => {
    const grid = await month();
    // Something to paste, copied as a person copies it.
    await grid.focus();
    await page.keyboard.type("1001");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+c");
    await page.keyboard.press("Escape");
    // The browser sends a paste to where the text selection is, a cell, not to the focused grid.
    for (const focus of [() => grid.focus(), () => dayCell(2, 3).click()]) {
      await focus();
      await page.keyboard.press("ControlOrMeta+v");
      await element(page.getByRole("dialog")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await element(page.getByRole("dialog")).toHaveCount(0);
    }
  });

  test("a press inside the open editor places the caret and keeps the editor", async () => {
    const grid = await month();
    await grid.focus();
    await page.keyboard.type("12345");
    await editor.click();
    await element(editor).toBeFocused();
    await element(editor).toHaveValue("12345");
    await element(drafts).toHaveText("{}");
    // The cell is taller and wider than the input's line of text: a press on the cell beside it keeps the editor too.
    await dayCell(1, 1).click({ position: { x: 40, y: 2 } });
    await element(editor).toBeFocused();
    await element(editor).toHaveValue("12345");
    await element(drafts).toHaveText("{}");
    // A double-click selects the word it is on; what is typed next replaces it.
    await editor.dblclick();
    await element(editor).toHaveValue("12345");
    await page.keyboard.type("9-18");
    await element(editor).toHaveValue("9-18");
    await page.keyboard.press("Enter");
    await element(drafts).toHaveText(`{${FIRST}}`);
  });

  test("Enter, F2 and a double-click open the editor on the cell's draft, and leaving it unchanged keeps the draft", async () => {
    await month();
    const DRAFT = '{"0001|2026-10-05":"9-18"}';
    await dayCell(1, 5).dblclick();
    await page.keyboard.type("9-18");
    await dayCell(2, 2).click();
    await element(drafts).toHaveText(DRAFT);

    // A double-click, then a press on another cell.
    await dayCell(1, 5).dblclick();
    await element(editor).toBeFocused();
    await dayCell(2, 2).click();
    await element(editor).toHaveCount(0);
    await element(drafts).toHaveText(DRAFT);
    await dayCell(1, 5).dblclick();
    await element(editor).toHaveValue("9-18");
    await page.keyboard.press("Escape");
    // Enter then Enter, F2 then Tab.
    for (const [open, close] of [["Enter", "Enter"], ["F2", "Tab"]] as const) {
      await dayCell(1, 5).click();
      await page.keyboard.press(open);
      await element(editor).toHaveValue("9-18");
      await page.keyboard.press(close);
      await element(editor).toHaveCount(0);
      await element(drafts).toHaveText(DRAFT);
    }
    // None of those was a change, so one step back undoes the draft itself.
    await dayCell(2, 2).click();
    await page.keyboard.press("Control+z");
    await element(drafts).toHaveText("{}");
    await page.keyboard.press("Control+y");
    await element(drafts).toHaveText(DRAFT);

    // A typed character still starts over, and emptying the editor still removes the draft.
    await dayCell(1, 5).click();
    await page.keyboard.type("x");
    await element(editor).toHaveValue("x");
    await page.keyboard.press("Escape");
    await element(drafts).toHaveText(DRAFT);
    await dayCell(1, 5).dblclick();
    await editor.fill("");
    await page.keyboard.press("Enter");
    await element(drafts).toHaveText("{}");
    // A cell with no draft opens empty, and leaving it is not a step to undo.
    await dayCell(3, 3).dblclick();
    await element(editor).toHaveValue("");
    await page.keyboard.press("Enter");
    await dayCell(2, 2).click();
    await page.keyboard.press("Control+z");
    await element(drafts).toHaveText(DRAFT);
  });
}
