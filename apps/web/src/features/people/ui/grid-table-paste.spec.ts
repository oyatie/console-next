// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, mount } from "./grid-table-fixture.playwright";
import { expectAxe } from "../../../../../../e2e/a11y";

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
    await page.locator("#grid-0-2").evaluate((cell) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", '"HR\tlead\nPM"\r\n"HR, payroll"\r\n');
      const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: clipboardData });
      cell.dispatchEvent(paste);
    });
    await expect(page.locator("#grid-0-2")).toHaveText("HR\tlead\nPM");
    await expect(page.locator("#grid-1-2")).toHaveText("HR, payroll");
    await expectAxe(page, `quoted paste ${width}`, { include: "#gallery-grid-table" });
  });
}
