// SPDX-License-Identifier: LicenseRef-Proprietary
import { chromium, expect as visible, type Browser, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { BoardRow, DayBoard } from "../api";
import { pickerTestServer } from "../../../ui/server-picker/browser-test";

let server: Awaited<ReturnType<typeof pickerTestServer>>;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  const row = (id: string): BoardRow => ({
    employee_id: id, name: id, employee_number: id, own: false, month_state: { state: "OPEN" },
    day: { date: "2026-10-06", plan: { kind: "NO_SCHEDULE", holiday_work: false }, marks: ["NO_SCHEDULE"],
      recognition: { recorded: 0, recognised: 0, late_in: 0, early_out: 0, away: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, approval_unused: 0 } },
  });
  const groups = ["판교지점 › 영업1팀", "판교지점 › 지원팀"].map((name, i) => ({
    name, unit_id: name, people: i + 2, normal: 0, no_schedule: i + 2, hidden: 0,
    marks: { blocking: i + 2, decision: 0, info: 0 }, rows: Array.from({ length: i + 2 }, (_, n) => row(`${i}-${n}`)),
  }));
  const board = { date: "2026-10-06", ledger: { people: 5 }, groups } as DayBoard;

  server = await pickerTestServer("day-detail", `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { loadCatalog } from '@console/i18n';
    import { DayDetail } from '/apps/web/src/features/attendance/ui/day-detail.tsx';
    import { useDrafts } from '/apps/web/src/features/attendance/ui/use-drafts.ts';
    import '/apps/web/src/app.css';
    await loadCatalog('ko');
    function Fixture() {
      const store = useDrafts('day-detail-test');
      const [note, setNote] = useState(null);
      return h('main', null, h('h1', null, 'Day detail'), note && h('p', {role: 'status'}, note), h(DayDetail, {board: ${JSON.stringify(board)}, store, onAssign() {}, onNote: setNote}));
    }
    createRoot(document.getElementById('root')).render(h(Fixture));
  `);
  browser = await chromium.launch();
  page = await browser.newPage();
  if (process.env.E2E_CPU_THROTTLE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.E2E_CPU_THROTTLE) });
  }
  await page.addInitScript(() => sessionStorage.clear());
}, 60_000);
beforeEach(async () => {
  const port = (server.httpServer!.address() as { port: number }).port;
  await page.goto(`http://localhost:${port}/day-detail`);
});
afterAll(async () => { await browser?.close(); await server?.close(); });

const paste = (input: Locator, text: string) => input.evaluate((el, value) => {
  const data = new DataTransfer();
  data.setData("text/plain", value);
  el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
}, text);

test.each(["pointer", "keyboard"])("grouped virtual detail keeps editable validation and prints every native row after %s entry", async entry => {
  const grids = page.getByRole("grid");
  await visible(grids).toHaveCount(2);
  await visible(grids.nth(0)).toHaveAttribute("aria-rowcount", "3");
  await visible(grids.nth(1)).toHaveAttribute("aria-rowcount", "4");
  const input = page.getByRole("textbox", { name: /^0-0 입력/ });
  // Enter the grid as a user: fill() alone starts React Aria's deferred virtual row focus.
  if (entry === "pointer") await input.click();
  else {
    await page.getByRole("textbox", { name: "사람 찾기 — 이름·사번", exact: true }).click();
    await page.keyboard.press("Tab");
    await visible(grids.first().getByRole("row").nth(1)).toBeFocused();
    for (const column of ["number", "name", "plan", "input"]) {
      await page.keyboard.press("ArrowRight");
      await visible(grids.first().locator(`[data-key="0-0:${column}"]`)).toBeFocused();
    }
    await visible(grids.first().getByRole("gridcell").filter({ has: input })).toBeFocused();
    await page.keyboard.press("Tab");
  }
  await visible(input).toBeFocused();
  const original = await input.evaluateHandle(el => {
    const state = { input: el, row: el.closest('[role="row"]'), blurs: 0 };
    el.addEventListener("blur", () => state.blurs++);
    return state;
  });
  await input.fill("+2");
  await visible(input).toBeFocused();
  await visible(input).toHaveAttribute("aria-invalid", "true");
  await visible(input).toHaveAccessibleDescription(/연장은 승인 기록으로만 반영됩니다/);
  await input.clear();
  await visible(input).not.toHaveAttribute("aria-invalid");
  await visible(input).toBeFocused();
  await page.keyboard.type("+2");
  await visible(input).toHaveValue("+2");
  await visible(input).toHaveAttribute("aria-invalid", "true");
  await visible(input).toBeFocused();
  expect(await input.evaluate((el, before) => ({
    sameInput: el === before.input, sameRow: el.closest('[role="row"]') === before.row, blurs: before.blurs,
  }), original)).toEqual({ sameInput: true, sameRow: true, blurs: 0 });
  await original.dispose();
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 0));
  await input.press("ArrowRight");
  await visible(input).toBeFocused();
  await visible.poll(() => input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(1);
  const text = "0-0\t+2\n1-2\t+2";
  await paste(page.getByRole("textbox", { name: "사람 찾기 — 이름·사번", exact: true }), text);
  await visible(page.getByText(/붙여넣은/)).toHaveCount(0);
  await paste(input, text);
  await visible(page.getByRole("status")).toContainText(/붙여넣은 2행.*일치 2/);
  await visible(page.getByRole("textbox", { name: /^1-2 입력/ })).toHaveValue("+2");
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  const paper = page.getByRole("table", { name: "일별 · 자세히" });
  await visible(paper.locator("tbody tr[data-id]")).toHaveCount(5);
  await visible(paper.locator('th[scope="rowgroup"]')).toHaveCount(2);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await visible(page.getByRole("textbox", { name: /^0-0 입력/ })).toHaveValue("+2");
});
