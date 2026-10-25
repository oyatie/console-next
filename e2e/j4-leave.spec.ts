import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go, koDate, registerEmployee } from "./flows";
import { hrAct, hrItem, hrMenu, openHistory } from "./record";
import { staffedTenant } from "./setup-flows";
import { reasonBox, sheet, todayPreset, fillDate } from "./sheet";

// J4 휴직·복직: leave carries a type and an expected return; the roster filters by status.
test("J4 leave of absence with a leave type, then return", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "j4co", "휴직주식회사");
  const c = clickCounter();
  await registerEmployee(admin, { name: "육아빠", number: "J4-0001" });
  await openHistory(admin);

  await hrAct(admin, "휴직 처리", c.click);
  const leave = sheet(admin, "육아빠 휴직 처리");
  // The type is required (BW-13) and nothing is chosen until pressed; 육아휴직 also needs its expected return.
  await expect(leave.getByRole("radio", { checked: true })).toHaveCount(0);
  await c.click(leave.getByText("육아휴직", { exact: true }));
  await c.click(todayPreset(leave));
  await leave.getByRole("button", { name: "휴직 1명 반영", exact: true }).click(); // a check, not part of the journey
  await expect(leave).toContainText("육아휴직·출산전후휴가는 복직 예정일을 정해야 합니다");
  await fillDate(leave, "2027-09-30", "복직 예정일");
  await expect(leave).toContainText(`복직 예정일은 ${koDate("2027-09-30")} (목)입니다`);
  await reasonBox(leave).fill("육아 휴직 신청");
  await expect(leave.getByRole("checkbox")).toHaveCount(0); // BW-11 A13: no statement to tick
  await expectAccessible(admin, "J4: leave sheet with leave type");
  await c.click(leave.getByRole("button", { name: "휴직 1명 반영", exact: true }));
  const history = admin.getByRole("region", { name: "인사 이력" });
  await expect(history).toContainText("복직 예정일은 2027. 09. 30.입니다");
  await expect(history).toContainText("육아휴직");
  // 전보 and 승진 stay in place, focusable but unavailable, with one shared reason and its remedy beside them.
  // Base 3 (발령, 휴직 처리, commit) + 1 type + 1 date; no statement to tick (BW-11 A13; spec §5 counts 발령 → act as two).
  expect(c.done("J4 place on leave")).toBeLessThanOrEqual(5);
  const menu = await hrMenu(admin);
  await expect(menu.getByRole("menuitem")).toHaveText([/^전보/, /^전적/, /^승진 처리/, /^직책 임면/, /^고용형태 전환/, /^복직 처리/]);
  await expect(hrItem(menu, "전보")).toHaveAttribute("aria-disabled", "true");
  await expect(hrItem(menu, "전보")).toContainText("전보는 휴직 중에는 할 수 없습니다.");
  await admin.keyboard.press("Escape");

  await go(admin, "/people");
  const statusChip = (name: RegExp) => admin.getByRole("group", { name: "상태" }).getByRole("button", { name });
  await statusChip(/^휴직/).click();
  await expect(statusChip(/^휴직 1$/)).toHaveAttribute("aria-pressed", "true"); // the chip is the filter, with the server's count
  await expect(admin.getByRole("row", { name: /육아빠/ })).toContainText("휴직");
  await statusChip(/^재직/).click();
  await expect(admin.getByText("선택한 조건에 맞는 직원이 없습니다")).toBeVisible();
  await expectAccessible(admin, "J4: people list filtered by status");
  // The empty result offers the way back: clearing the filters shows the roster again.
  await admin.getByRole("button", { name: "검색·필터 초기화" }).click();
  await expect(admin.getByRole("row", { name: /육아빠/ })).toBeVisible();

  // Return from the roster: the status chip, the row, then the panel's 복직 처리 opens it on the record.
  await c.click(statusChip(/^휴직/));
  await c.click(admin.getByRole("rowheader", { name: "육아빠", exact: true }));
  const panel = admin.getByRole("complementary", { name: "직원 상세" });
  await expect(panel.getByRole("navigation", { name: "인사 조치" }).getByRole("link")).toHaveText(["복직 처리"]); // only what the server offers
  await c.click(panel.getByRole("link", { name: "복직 처리" }));
  const ret = sheet(admin, "육아빠 복직 처리");
  await expect(ret).toContainText(/휴직 \d{4}-\d{2}-\d{2} ~ 2027-09-30 · 육아휴직 · 휴직 전 부서 /);
  // The planned return is offered as a date of its own.
  await expect(ret.getByRole("button", { name: /^예정대로/ })).toBeVisible();
  await c.click(todayPreset(ret));
  await reasonBox(ret).fill("육아 휴직 종료");
  await c.click(ret.getByRole("button", { name: "복직 1명 반영", exact: true }));
  await openHistory(admin);
  await expect(history).toContainText("육아빠를 복직 처리했습니다");
  // Base 3 (chip, row, panel verb) + commit + 1 date; no statement to tick (BW-11 A13).
  expect(c.done("J4 return from leave (from the filtered roster)")).toBeLessThanOrEqual(5);
});
