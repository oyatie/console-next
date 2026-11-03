// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Locator } from "@playwright/test";
import { expect, test, mount } from "./grid-table-fixture.playwright";
import { expectAxe } from "../../../../../../e2e/a11y";

const excelHtml = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><!--StartFragment--><table>
<tr><td style="mso-number-format:'\\@'">Seoul &amp; HQ</td><td style="mso-number-format:'\\@'">=SUM(A1:A2)</td></tr>
<tr><td>two<br style="mso-data-placement:same-cell">lines</td><td style="mso-number-format:'\\@'">@literal</td></tr>
</table><!--EndFragment--></body></html>`;

async function pasteClipboard(cell: Locator, values: Record<string, string>) {
  await cell.evaluate((element, contents) => {
    const data = new DataTransfer();
    for (const [type, value] of Object.entries(contents)) data.setData(type, value);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  }, values);
}

test("the browser decodes CP949 extended Hangul and rejects an incomplete lead byte", async ({ page }) => {
  await mount(page, true);
  const decoded = await page.evaluate(async () => {
    const module = "/src/lib/sheet-file.ts";
    const { decodeSheetText } = await import(/* @vite-ignore */ module);
    const result = decodeSheetText(new Uint8Array([0x81, 0x41, 0xc6, 0x52]));
    let refused = false;
    try { decodeSheetText(new Uint8Array([0x81])); } catch (error) { refused = error instanceof TypeError; }
    return { result, refused };
  });
  expect(decoded).toEqual({ result: { text: "\uac02\ud7a3", encoding: "euc-kr" }, refused: true });
});

for (const width of [1440, 390]) {
  test(`spreadsheet paste preserves quoted cell boundaries at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, true);
    await page.locator("html").evaluate((element, theme) => { element.dataset.theme = theme; }, width === 390 ? "dark" : "light");
    await page.locator("#grid-0-2").evaluate((cell) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", '"HR\tlead\nPM"\r\n"HR, payroll"\r\n');
      const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: clipboardData });
      cell.dispatchEvent(paste);
    });
    await expect(page.locator("#grid-0-2")).toHaveText("HR\tlead\nPM");
    await expect(page.locator("#grid-1-2")).toHaveText("HR, payroll");
    await expectAxe(page, `quoted paste ${width} ${width === 390 ? "dark" : "light"}`, { include: "#gallery-grid-table" });
  });
}

test("Excel HTML wins over plain text and formula-looking values stay literal", async ({ page }) => {
  await mount(page, true);
  await pasteClipboard(page.locator("#grid-0-1"), { "text/html": excelHtml, "text/plain": "wrong\twrong" });
  await expect(page.locator("#grid-0-1")).toHaveText("Seoul & HQ");
  await expect(page.locator("#grid-0-2")).toHaveText("=SUM(A1:A2)");
  await expect(page.locator("#grid-1-1")).toHaveText("two\nlines");
  await expect(page.locator("#grid-1-2")).toHaveText("@literal");
  await expectAxe(page, "Excel HTML paste", { include: "#gallery-grid-table" });
});

test("copy writes the selected rectangle as TSV and an HTML table", async ({ page }) => {
  await mount(page, true);
  await pasteClipboard(page.locator("#grid-0-1"), { "text/plain": '"A\tB"\t=1+1\r\n"line 1\nline 2"\t<&>' });
  await page.locator("#grid-0-1").click();
  await page.locator("#grid-1-2").click({ modifiers: ["Shift"] });
  const copied = await page.locator("#grid-1-2").evaluate((cell) => {
    const data = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    cell.dispatchEvent(event);
    return { plain: data.getData("text/plain"), html: data.getData("text/html") };
  });
  expect(copied.plain).toBe('"A\tB"\t=1+1\r\n"line 1\nline 2"\t<&>');
  expect(await page.evaluate((html) => Array.from(new DOMParser().parseFromString(html, "text/html").querySelectorAll("td"), (cell) => ({ text: cell.textContent, breaks: cell.querySelectorAll("br").length })), copied.html)).toEqual([
    { text: "A\tB", breaks: 0 }, { text: "=1+1", breaks: 0 }, { text: "line 1line 2", breaks: 1 }, { text: "<&>", breaks: 0 },
  ]);
  await expectAxe(page, "grid copy", { include: "#gallery-grid-table" });
});

test("paste reports read-only and out-of-grid cells", async ({ page }) => {
  await mount(page, true, "table", true);
  await pasteClipboard(page.locator("#grid-0-0"), { "text/plain": "kept\tblocked\tkept too\toutside" });
  await expect(page.locator("#grid-0-0")).toHaveText("kept");
  await expect(page.locator("#grid-0-1")).toHaveText("");
  await expect(page.locator("#grid-0-1")).toHaveAttribute("data-readonly", "true");
  await expect(page.locator("#grid-0-2")).toHaveText("kept too");
  await expect(page.getByRole("status").filter({ hasText: "Not pasted" })).toContainText(/1 read-only.*1 outside/);
  await expectAxe(page, "partly refused grid paste", { include: "#gallery-grid-table" });
});
