import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";

// Longer than the server takes for 직무 (200 bytes): the grid lets it through, the server's check refuses that cell.
const LONG_JOB = "직".repeat(70);

// J6 일괄 수정 (spec E6-grid → preview → done, MR-27): pick people, paste a spreadsheet block, fix the cell in error,
// check what the server will write, apply it once, and see it on the card.
test("J6 bulk edit: a pasted block shows old → new, an error blocks only itself, the check and the commit write the rest", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "j6grid", "정정주식회사");
  const api = apiOf(admin, bearerOf(admin));
  const c = clickCounter();
  const names = ["강정정", "남정정", "도정정"];
  for (const [i, name] of names.entries()) await registerEmployee(admin, { name, number: `G-000${i + 1}`, unit: "인사부" });

  await go(admin, "/people");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("정정");
  await find.press("Enter");
  for (const name of names) await c.click(admin.getByRole("row", { name: new RegExp(name) }).locator("label", { has: admin.getByRole("checkbox") }));
  await c.click(admin.getByRole("button", { name: "선택한 3명 일괄 수정" }));
  await expect(admin.getByRole("heading", { name: "일괄 수정 · 인사부", level: 1 })).toBeVisible();
  const grid = admin.getByRole("grid");
  await expect(grid.getByRole("row")).toHaveCount(4);

  // A block pasted from row 1 성별: sex, address, job; row 3's sex is not a value, row 2's address has no district.
  const first = admin.getByRole("gridcell", { name: "1행 성별" });
  await first.focus();
  await first.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    // Firefox ignores clipboardData in the constructor: it is set on the event instead (as a real paste carries it).
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    el.dispatchEvent(ev);
  }, `남\t경기 평택시 고덕동 31\t생산·조립\n여\t고덕동 9\t${LONG_JOB}\n남자?\t\t생산 관리\n`);
  await expect(admin.getByRole("gridcell", { name: "1행 주소" })).toContainText("경기 평택시 고덕동 31");
  await expect(admin.getByRole("gridcell", { name: "3행 성별" })).toHaveAttribute("aria-invalid", "true");
  await expect(admin.getByRole("gridcell", { name: "2행 주소" })).toHaveAttribute("aria-invalid", "true");
  await expect(admin.getByRole("group", { name: "보기" }).getByRole("button", { name: "오류 2" })).toBeVisible();
  await expectAccessible(admin, "J6 grid: pasted block with errors");

  // F8 goes to the first error; its tip says why and offers the near value, which Enter takes.
  await first.focus();
  await admin.keyboard.press("F8");
  await expect(admin.getByRole("gridcell", { name: "2행 주소" }).locator("input")).toBeFocused();
  await expect(admin.getByRole("status").filter({ hasText: "시·군·구가 없는 주소" })).toBeVisible();
  await admin.keyboard.press("Delete");
  await admin.keyboard.press("F8");
  await expect(admin.getByRole("gridcell", { name: "3행 성별" }).locator("input")).toBeFocused();
  await admin.keyboard.press("Enter");
  await expect(admin.getByRole("gridcell", { name: "3행 성별" })).not.toHaveAttribute("aria-invalid", "true");

  // The check: per column and per row, nothing written yet; the reason is required before applying.
  await c.click(admin.getByRole("button", { name: /^확인으로/ }));
  await expect(admin.getByRole("heading", { name: /칸별 확인/ })).toBeVisible();
  await expect(admin.getByRole("table", { name: /칸별 확인/ }).getByRole("row").last()).toContainText("합계");
  const rows = admin.getByRole("table", { name: "줄별 보기" });
  await expect(rows.getByRole("row", { name: /강정정/ })).toContainText("경기 평택시 고덕동 31");
  await expect(rows).not.toContainText("MANUAL_UNVERIFIED");
  // The server's check refused one cell (BE-EMP-UI §6): the row names the field it refused.
  await expect(rows.getByRole("row", { name: /남정정/ })).toContainText("직무 · ");
  await c.click(admin.getByRole("button", { name: /칸 반영/ }));
  await expect(admin.getByText("사유 분류를 선택하십시오").first()).toBeVisible();
  await c.click(admin.getByRole("radiogroup", { name: /정정 사유/ }).getByText("입력 실수", { exact: true }));
  await expectAccessible(admin, "J6 grid: check");
  await c.click(admin.getByRole("button", { name: /칸 반영/ }));
  await expect(admin.getByRole("heading", { name: /반영했습니다/ })).toBeVisible();
  await expectAccessible(admin, "J6 grid: done");
  // What was not written comes back to the grid: the refused cell is an error, with the server's reason, until retyped.
  await admin.getByRole("button", { name: /^남은 오류 \d+칸 수정/ }).click();
  const refused = admin.getByRole("gridcell", { name: "2행 직무" });
  await expect(refused).toHaveAttribute("aria-invalid", "true");
  await refused.focus();
  await expect(admin.getByRole("status").filter({ hasText: "확인에서 받지 않았습니다" })).toBeVisible();

  // The card shows the corrected job.
  let release!: () => void;
  let requested = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await admin.route("**/api/v1/employees?**", async (r) => {
    const response = await r.fetch();
    if (new URL(r.request().url()).searchParams.get("search") === "정정") {
      requested = true;
      await held;
    }
    await r.fulfill({ response });
  });
  try {
    await go(admin, "/people");
    await expect.poll(() => requested).toBe(true);
    await find.fill("G-0001");
  } finally {
    release();
  }
  // A delayed Back read must not restore row focus over someone already typing a new search.
  await expect(admin.getByRole("row", { name: /G-0001/ })).toBeVisible();
  await admin.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(find).toBeFocused();
  await find.press("Enter");
  await expect(admin.getByRole("heading", { level: 1 })).toContainText("강정정");
  await expect(admin.getByText("생산·조립").first()).toBeVisible();
  expect(c.done("J6 bulk edit")).toBeLessThanOrEqual(10);

  // The commit is bound to its preview (MR-27): without a digest, or with one that no longer matches the records,
  // the server writes nothing (asserted by reading the record back).
  const [p] = ((await (await api("/employees?employee_number=G-0002")).json()) as { items: { id: string; updated_at: string }[] }).items;
  // The record's revision: unchanged means nothing was written.
  const job = async () => ((await (await api(`/employees/${p!.id}`)).json()) as { employee: { updated_at: string } }).employee.updated_at;
  const before = await job();
  const lines = [{ employee_id: p!.id, changes: { job: "물류" }, expected_updated_at: p!.updated_at }];
  const noDigest = await api("/employees/corrections/bulk", "POST", { rows: lines, reason_code: "TYPO" }, { "Idempotency-Key": crypto.randomUUID() });
  expect(noDigest.status()).toBe(422);
  const stale = await api("/employees/corrections/bulk", "POST", { rows: lines, reason_code: "TYPO", preview_digest: "0".repeat(64) }, { "Idempotency-Key": crypto.randomUUID() });
  expect([stale.status(), await codeOf(stale)]).toEqual([409, "rows_changed_since_preview"]);
  expect(await job()).toBe(before);
});
