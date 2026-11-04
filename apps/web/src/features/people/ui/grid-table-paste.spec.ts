// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Locator } from "@playwright/test";
import { expect, test, mount } from "./grid-table-fixture.playwright";
import { expectAxe } from "../../../../../../e2e/a11y";

// Synthetic because Excel is unavailable here; follows Microsoft's CF_HTML grammar:
// https://learn.microsoft.com/en-us/windows/win32/dataxchg/html-clipboard-format
function cfHtml(fragment: string) {
  const start = "<!--StartFragment-->", end = "<!--EndFragment-->";
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta name="ProgId" content="Excel.Sheet"></head><body>${start}${fragment}${end}</body></html>`;
  const template = "Version:1.0\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  const startHtml = bytes(template), endHtml = startHtml + bytes(html);
  const startFragment = startHtml + bytes(html.slice(0, html.indexOf(start) + start.length));
  const endFragment = startHtml + bytes(html.slice(0, html.indexOf(end)));
  const offsets = [startHtml, endHtml, startFragment, endFragment].map((value) => String(value).padStart(10, "0"));
  return template.replace(/0000000000/g, () => offsets.shift()!) + html;
}

const excelHtml = cfHtml(`<table>
  <tr><td>Seoul headquarters people operations
    team lead</td><td>
    Payroll<span style="mso-spacerun:yes">&nbsp; </span>team
  </td><td>browser<br>break</td></tr>
  <tr><td>two<br style="mso-data-placement:same-cell">lines</td><td style="mso-number-format:'\\@'">=SUM(A1:A2)</td><td>@literal</td></tr>
</table>`);

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

test("with no Excel available, Microsoft-documented CF_HTML collapses source whitespace and keeps same-cell breaks", async ({ page }) => {
  await mount(page, true);
  await pasteClipboard(page.locator("#grid-0-0"), { "text/html": excelHtml, "text/plain": "Seoul headquarters people operations team lead\tPayroll  team\tbrowser break\r\ntwo lines\t=SUM(A1:A2)\t@literal" });
  expect(await page.locator("#grid-0-0").textContent()).toBe("Seoul headquarters people operations team lead");
  expect(await page.locator("#grid-0-1").textContent()).toBe("Payroll  team");
  expect(await page.locator("#grid-0-2").textContent()).toBe("browser break");
  expect(await page.locator("#grid-1-0").textContent()).toBe("two\nlines");
  expect(await page.locator("#grid-1-1").textContent()).toBe("=SUM(A1:A2)");
  expect(await page.locator("#grid-1-2").textContent()).toBe("@literal");
  await expectAxe(page, "Excel CF_HTML paste", { include: "#gallery-grid-table" });
});

test("plain clipboard data is retained when normalized HTML adds nothing", async ({ page }) => {
  await mount(page, true);
  const preferred = await page.evaluate(async () => {
    const module = "/src/ui/sheet-grid/clipboard.ts";
    const { readClipboard } = await import(/* @vite-ignore */ module);
    const data = new DataTransfer();
    data.setData("text/plain", "Seoul HQ");
    data.setData("text/html", "<table><tr><td>  Seoul\n  HQ  </td></tr></table>");
    const plain = [["Seoul HQ"]];
    return readClipboard(data, () => plain) === plain;
  });
  expect(preferred).toBe(true);
});

for (const [width, locale] of [[1440, "en"], [390, "ko"]] as const) {
  test(`paste feedback announces and keeps the banner in view at row 73 (${width}px ${locale})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((lang) => localStorage.setItem("console.locale", lang), locale);
    await mount(page, true, "page");
    if (width === 390) await page.locator("html").evaluate((element) => { element.dataset.theme = "dark"; });
    const announcer = page.locator('.sr-only[role="status"]');
    const banner = page.locator('#gallery-grid-table [data-placement="page"][data-tone="warn"]');
    await expect(announcer).toHaveCount(1);
    await expect(banner).toHaveCount(0);
    await page.locator("#gallery-grid-table [role='grid']").evaluate((grid) => {
      const scroller = grid.parentElement!;
      const rowHeight = parseFloat(getComputedStyle(grid).getPropertyValue("--row-h"));
      const headHeight = grid.firstElementChild!.firstElementChild!.getBoundingClientRect().height;
      scroller.scrollTop = headHeight + 73 * rowHeight - scroller.clientHeight;
    });
    const target = page.locator("#grid-72-2");
    await expect(target).toBeVisible();
    await target.click();
    await expect(target.locator("input")).toBeFocused();
    await pasteClipboard(target, { "text/plain": "kept\toutside" });
    await expect(banner).toBeVisible();
    if (locale === "en") {
      await expect(banner).toHaveText("Not pasted · 1 outside the grid");
      await expect(announcer).toHaveText("Not pasted · 1 outside the grid");
    } else {
      const pasteVerb = (await page.locator("#gallery-grid-table button").filter({ hasText: "⌘V" }).innerText()).trim().slice(0, 3);
      const notice = (await banner.innerText()).trim();
      expect(notice.startsWith(pasteVerb)).toBe(true);
      expect(notice).toContain("1");
      expect(notice).not.toContain("0");
      await expect(announcer).toHaveText(notice);
    }
    await expect(target.locator("input")).toBeFocused();
    const layout = await banner.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const cell = document.getElementById("grid-72-2")!.getBoundingClientRect();
      const bar = document.querySelector("#gallery-grid-table footer")!.getBoundingClientRect();
      return {
        bannerInView: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
        cellAboveBar: cell.bottom <= bar.top && cell.top >= box.bottom,
      };
    });
    expect(layout).toEqual({ bannerInView: true, cellAboveBar: true });
    await expect(page.locator("[class*='verbs']")).not.toContainText(await banner.innerText());
    await expectAxe(page, `GridPage paste notice ${width} ${locale}`, { include: "#gallery-grid-table" });
  });
}

test("HTML still wins when its same-cell break adds information", async ({ page }) => {
  await mount(page, true);
  await pasteClipboard(page.locator("#grid-0-1"), { "text/html": "<table><tr><td>two<br style='mso-data-placement:same-cell'>lines</td><td>=SUM(A1:A2)</td></tr></table>", "text/plain": "two lines\t=SUM(A1:A2)" });
  expect(await page.locator("#grid-0-1").textContent()).toBe("two\nlines");
  expect(await page.locator("#grid-0-2").textContent()).toBe("=SUM(A1:A2)");
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
  expect(await page.evaluate((html) => Array.from(new DOMParser().parseFromString(html, "text/html").querySelectorAll("td"), (cell) => ({
    text: cell.textContent,
    breaks: cell.querySelectorAll('br[style="mso-data-placement:same-cell"]').length,
  })), copied.html)).toEqual([
    { text: "A\tB", breaks: 0 }, { text: "=1+1", breaks: 0 }, { text: "line 1line 2", breaks: 1 }, { text: "<&>", breaks: 0 },
  ]);
  await expectAxe(page, "grid copy", { include: "#gallery-grid-table" });
});

test("copy and paste round-trip preserves in-cell line breaks", async ({ page }) => {
  await mount(page, true);
  await pasteClipboard(page.locator("#grid-0-1"), { "text/plain": '"line 1\nline 2"' });
  expect(await page.locator("#grid-0-1").textContent()).toBe("line 1\nline 2");
  await page.locator("#grid-0-1").click();
  const copied = await page.locator("#grid-0-1").evaluate((cell) => {
    const data = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    cell.dispatchEvent(event);
    return { "text/plain": data.getData("text/plain"), "text/html": data.getData("text/html") };
  });
  await pasteClipboard(page.locator("#grid-1-1"), copied);
  expect(await page.locator("#grid-1-1").textContent()).toBe("line 1\nline 2");
  await expectAxe(page, "multiline copy-paste round-trip", { include: "#gallery-grid-table" });
});

for (const value of ["a  b", " leading", "in\tcell", "  line 1\nline 2"]) {
  test(`copy and paste round-trip preserves exact whitespace ${JSON.stringify(value)}`, async ({ page }) => {
    await mount(page, true);
    await pasteClipboard(page.locator("#grid-0-1"), { "text/plain": `"${value}"` });
    expect(await page.locator("#grid-0-1").textContent()).toBe(value);
    await page.locator("#grid-0-1").click();
    const copied = await page.locator("#grid-0-1").evaluate((cell) => {
      const data = new DataTransfer();
      const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      cell.dispatchEvent(event);
      return { "text/plain": data.getData("text/plain"), "text/html": data.getData("text/html") };
    });
    await pasteClipboard(page.locator("#grid-1-1"), copied);
    expect(await page.locator("#grid-1-1").textContent()).toBe(value);
  });
}

test("merged HTML cells reserve blank columns and rows", async ({ page }) => {
  await mount(page, true);
  const cells = await page.evaluate(async () => {
    const module = "/src/ui/sheet-grid/clipboard.ts";
    const { readClipboard } = await import(/* @vite-ignore */ module);
    const data = new DataTransfer();
    data.setData("text/html", '<table><tr><td colspan="2" rowspan="2">merged</td><td>right</td></tr><tr><td>below</td></tr><tr><td>end</td></tr></table>');
    return { htmlOnly: readClipboard(data, () => []), mismatched: readClipboard(data, () => [["merged", "right"], ["below"], ["end"]]) };
  });
  const expanded = [["merged", "", "right"], ["", "", "below"], ["end", "", ""]];
  expect(cells).toEqual({ htmlOnly: expanded, mismatched: expanded });
  await pasteClipboard(page.locator("#grid-0-0"), {
    "text/plain": "merged\t\tright",
    "text/html": '<table><tr><td colspan="2">merged</td><td>right</td></tr></table>',
  });
  expect(await page.locator("#grid-0-0").textContent()).toBe("merged");
  expect(await page.locator("#grid-0-1").textContent()).not.toBe("right");
  expect(await page.locator("#grid-0-2").textContent()).toBe("right");
});

test("plain quoted multiline cells survive HTML with a bare br", async ({ page }) => {
  await mount(page, true);
  await pasteClipboard(page.locator("#grid-0-1"), {
    "text/plain": '"line 1\nline 2"\t  spaced',
    "text/html": "<table><tr><td>line 1<br>line 2</td><td> spaced</td></tr></table>",
  });
  expect(await page.locator("#grid-0-1").textContent()).toBe("line 1\nline 2");
  expect(await page.locator("#grid-0-2").textContent()).toBe("  spaced");
  await pasteClipboard(page.locator("#grid-1-1"), {
    "text/plain": 'two lines\t"  exact\tspacing"',
    "text/html": "<table><tr><td>two<br style='mso-data-placement:same-cell'>lines</td><td> exact spacing</td></tr></table>",
  });
  expect(await page.locator("#grid-1-1").textContent()).toBe("two\nlines");
  expect(await page.locator("#grid-1-2").textContent()).toBe("  exact\tspacing");
});

test("paste reports read-only and out-of-grid cells", async ({ page }) => {
  await mount(page, true, "table", true);
  const announcer = page.locator('.sr-only[role="status"]');
  const banner = page.locator('#gallery-grid-table [data-placement="page"][data-tone="warn"]');
  await expect(announcer).toBeEmpty();
  await expect(banner).toHaveCount(0);
  const readOnly = page.locator("#grid-0-1"), before = await readOnly.innerText();
  await pasteClipboard(page.locator("#grid-0-0"), { "text/plain": "kept\tblocked\tkept too\toutside" });
  await expect(page.locator("#grid-0-0")).toHaveText("kept");
  await expect(readOnly).toHaveText(before);
  await expect(readOnly).toHaveAttribute("data-readonly", "true");
  await expect(page.locator("#grid-0-2")).toHaveText("kept too");
  await expect(announcer).toHaveText("Not pasted · 1 read-only · 1 outside the grid");
  await expect(banner).toHaveText("Not pasted · 1 read-only · 1 outside the grid");
  await expectAxe(page, "partly refused grid paste", { include: "#gallery-grid-table" });
});
