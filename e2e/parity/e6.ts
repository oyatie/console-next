import { expect, type Page } from "@playwright/test";
import { go } from "../flows";
import { frame, shot } from "./shot";

// E6 일괄 frames on the parity world after 운영 시작: the bulk act workspace and the correction grid with its check.

/** The roster with the first `n` people of a unit picked. */
async function pickFrom(page: Page, unit: string, n: number) {
  await go(page, "/people");
  const find = page.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("");
  await find.press("Enter");
  const rows = page.getByRole("row").filter({ hasText: unit });
  for (let i = 0; i < n; i++) await rows.nth(i).locator("label", { has: page.getByRole("checkbox") }).click();
}

/** Pastes a tab-separated block into the focused grid cell, as a spreadsheet copy does. */
async function pasteInto(page: Page, cell: string, tsv: string) {
  const target = page.getByRole("gridcell", { name: cell });
  await target.focus();
  await target.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    // Firefox ignores clipboardData in the constructor: it is set on the event instead (as a real paste carries it).
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    el.dispatchEvent(ev);
  }, tsv);
}

export async function captureE6(page: Page, gridOnly = false) {
  if (!gridOnly) await frame(page, "E6-move", async () => {
    await pickFrom(page, "생산3팀", 4);
    await page.getByRole("button", { name: /^선택한 4명 일괄 발령/ }).click();
    await page.getByRole("group", { name: "무엇을" }).getByRole("button", { name: "전보" }).click();
    await page.getByRole("listbox", { name: "어디로" }).getByRole("option", { name: /^생산1팀/ }).click();
    await page.getByRole("button", { name: /^다음 달 1일/ }).click();
    const reason = page.getByRole("radiogroup", { name: /^사유/ });
    if (await reason.isVisible()) await reason.getByRole("radio").first().locator("xpath=ancestor::label[1]").click();
    await page.getByRole("textbox", { name: /^메모/ }).fill("생산3팀 라인 축소");
    await shot(page, "E6-move");
  });
  await frame(page, "E6-grid", async () => {
    await pickFrom(page, "생산3팀", 4);
    await page.getByRole("button", { name: /^선택한 4명 일괄 수정/ }).click();
    await expect(page.getByRole("grid")).toBeVisible();
    // 성별 · 주소 · 직무 for four rows: one sex no list has, two addresses, one job filled down.
    await pasteInto(page, "1행 성별", "남\t경기 평택시 고덕동 31\t생산·조립\n여\t경기 평택시 세교동 588-2\t\nM?\t\t생산 관리\n\t충남 아산시 둔포면 운용리 9\t");
    await page.getByRole("gridcell", { name: "3행 성별" }).focus();
    await shot(page, "E6-grid");
    if (!gridOnly) await shot(page, "E6-grid", { dark: true });
  });
  if (gridOnly) return;
  await frame(page, "E6-columns", async () => {
    await page.getByRole("button", { name: /^열 선택/ }).click();
    await expect(page.getByRole("dialog", { name: "열 선택" })).toBeVisible();
    await shot(page, "E6-columns");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "열 선택" })).toBeHidden();
  });
  await frame(page, "E6-preview", async () => {
    await page.getByRole("gridcell", { name: "3행 성별" }).focus();
    await page.keyboard.press("Delete");
    await page.getByRole("button", { name: /^확인으로/ }).click();
    await expect(page.getByRole("heading", { name: /칸별 확인/ })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("radiogroup", { name: /정정 사유/ }).getByText("입력 실수", { exact: true }).click();
    await shot(page, "E6-preview");
  });
  await frame(page, "E6-done", async () => {
    await page.getByRole("button", { name: /칸 반영/ }).click();
    await expect(page.getByRole("heading", { name: /반영했습니다/ })).toBeVisible({ timeout: 15_000 });
    await shot(page, "E6-done");
  });
}
