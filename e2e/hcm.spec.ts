import { expect, test } from "@playwright/test";
import { clickCounter } from "./clicks";
import { expectAccessible } from "./a11y";
import { fillRegister, openRegistered, pressRegister, receiptOf, registerSheet } from "./helpers/register";
import { forgetResize } from "./stability";
import { go, kstDate } from "./flows";
import { hrAct, hrItem, hrMenu } from "./record";
import { tenantWithExecutive } from "./setup-flows";
import { reasonChip } from "./helpers/lifecycle";
import { box, revealUnit } from "./structure-flows";
import { reasonBox, sheet, signOff, todayPreset, fillDate } from "./sheet";
import { rosterXlsx } from "./workbook";
import { chooseWorkbook, payPeriod } from "./helpers/import";

/**
 * The HR administrator's first week, from an empty tenant: build the org, staff it, move and
 * exit people. Every structural change goes through approval by a different person.
 */
test("HCM journey: org structure → staffing → transfer → promotion → leave → contract renewal → roster import → exit", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantWithExecutive(browser, "hcm", "한결물산");
  const c = clickCounter();

  // A structure change from its sheet: the effective date has no default, so one deliberate pick («오늘», applied right
  // away), and its reason. With no 결재 (decisions #26, the default) a change dated today applies at submit.
  async function apply(dialog: string, reason: string) {
    const s = admin.getByRole("dialog", { name: dialog });
    await c.click(s.getByRole("button", { name: /^오늘/ }));
    await s.getByLabel("사유").fill(reason);
    await c.click(s.getByRole("button", { name: "반영 · 항목 1개" }));
    // org-19: the press keeps the user on the chart; the receipt names this change (an earlier one may still be announced).
    await expect(admin.getByRole("dialog", { name: dialog })).toBeHidden();
    await expect(admin.getByRole("status").filter({ hasText: "반영했습니다" }).first()).toBeAttached();
    await expect(admin).toHaveURL(/\/org(\?|$)/);
  }

  // 1-2. A department under the 사업장 registered in setup, from its box on the chart (select, A). A 사업장 itself is
  // the 법인's own record, added from its 법인, never an org change (decisions #21, ENT-KIND MR-20).
  await go(admin, "/org");
  await c.click(box(admin, "본점"));
  await expectAccessible(admin, "org chart with a workplace selected");
  await admin.keyboard.press("a");
  await expectAccessible(admin, "new department sheet");
  await admin.getByRole("dialog", { name: "부서 신설" }).getByLabel("부서 이름").fill("인사부");
  await apply("부서 신설", "인사 기능 신설");
  expect(c.done("add a department")).toBeLessThanOrEqual(5);

  // 3. (Regions and branches are retired, decisions #18: the 사업장's own branch is everyone's home branch.)
  // 4. Register an employee from the department's box (unit is prefilled).
  await go(admin, "/org");
  await revealUnit(admin, "인사부");
  await c.click(admin.getByRole("complementary", { name: "인사부", exact: true }).getByRole("link", { name: "인사부에 직원 등록" }));
  await expect(registerSheet(admin).getByRole("textbox", { name: /^이름/ })).toBeVisible();
  await expectAccessible(admin, "register employee");
  // The full form at phone width: its rows wrap instead of scrolling sideways.
  await admin.setViewportSize({ width: 390, height: 844 });
  expect(await admin.evaluate(() => [document.scrollingElement!.scrollWidth - innerWidth, document.querySelector(".main")!.scrollWidth - document.querySelector(".main")!.clientWidth])).toEqual([0, 0]);
  await admin.setViewportSize({ width: 1280, height: 720 });
  await forgetResize(admin);
  // The employment type and hire date are chosen, never defaulted (the unit came with the link).
  await fillRegister(admin, { name: "정하늘", number: "HK-0001", hired: kstDate() }, c);
  await registerSheet(admin).getByRole("textbox", { name: /^직위/ }).fill("대리");
  await pressRegister(admin, false, c);
  await expect(receiptOf(admin, "정하늘")).toBeVisible();
  // Unit row + link (the place comes with it) + typed 사번 + date + type + register: spec §5 row 2 counts 6.
  expect(c.done("register employee")).toBeLessThanOrEqual(6);
  await openRegistered(admin, "정하늘", "HK-0001");
  await expect(admin.getByRole("heading", { name: /정하늘/ })).toBeVisible();
  await expect(admin.getByRole("group", { name: "소속" })).toContainText("인사부");

  // 5. A 부서 under the department (one 부서 kind at any depth, decisions #18), then transfer the employee into it.
  await go(admin, "/org");
  await revealUnit(admin, "인사부");
  await admin.keyboard.press("a");
  await admin.getByRole("dialog", { name: "부서 신설" }).getByLabel("부서 이름").fill("채용팀");
  await apply("부서 신설", "채용 전담");
  c.done("add a sub-department");

  await go(admin, "/people");
  await c.click(admin.getByRole("rowheader", { name: "정하늘", exact: true }));
  await c.click(admin.getByRole("complementary", { name: "직원 상세" }).getByRole("link", { name: "인사카드 열기" }));
  await hrAct(admin, "전보", c.click);
  const transfer = sheet(admin, "정하늘 전보");
  await expectAccessible(admin, "employee page + transfer sheet");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("채용");
  await c.click(admin.getByRole("option", { name: /채용팀/ }));
  await c.click(todayPreset(transfer));
  await c.click(reasonChip(transfer, "업무 필요"));
  await reasonBox(transfer).fill("채용 업무 전담");
  await c.click(transfer.getByRole("button", { name: "오늘 전보", exact: true }));
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /정하늘을 인사부에서 채용팀으로 전보했습니다/ })).toBeVisible();
  // Focus lands on the record the action added to the history, not on <body>.
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /정하늘을 인사부에서 채용팀으로 전보했습니다/ })).toBeFocused();
  await expectAccessible(admin, "employee page after transfer");
  expect(c.done("transfer employee")).toBeLessThanOrEqual(8); // 발령 → 전보 is two (spec §5)

  // 5b. Promotion, leave and return: the page offers only what the current status allows.
  const head = admin.getByRole("heading", { name: /정하늘/, level: 1 }).locator("..");
  const acts = await hrMenu(admin);
  await expect(hrItem(acts, "계약 갱신")).toHaveCount(0); // 정규직
  await admin.keyboard.press("Escape");
  await hrAct(admin, "승진 처리", c.click);
  const promote = sheet(admin, "정하늘 승진 처리");
  await promote.getByRole("textbox", { name: /^새 직위/ }).fill("과장");
  await c.click(todayPreset(promote));
  await c.click(reasonChip(promote, "정기 승진"));
  await reasonBox(promote).fill("정기 승진");
  await expect(promote.getByRole("checkbox")).toHaveCount(0); // BW-11 A13: no statement to tick
  await c.click(promote.getByRole("button", { name: "오늘 승진 처리", exact: true }));
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /정하늘을 대리에서 과장으로 승진 처리했습니다/ })).toBeVisible();
  expect(c.done("promote employee")).toBeLessThanOrEqual(5);

  await hrAct(admin, "휴직 처리", c.click);
  const leave = sheet(admin, "정하늘 휴직 처리");
  await c.click(leave.getByText("육아휴직", { exact: true }));
  await c.click(todayPreset(leave));
  await fillDate(leave, "2027-03-31", "복귀 예정일");
  await reasonBox(leave).fill("육아 휴직");
  await expect(leave.getByRole("checkbox")).toHaveCount(0); // BW-11 A13: no statement to tick
  await expectAccessible(admin, "leave sheet");
  await c.click(leave.getByRole("button", { name: "오늘 휴직 처리", exact: true }));
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /정하늘을 휴직 처리했습니다\. 복귀 예정일은/ })).toBeVisible();
  await expect(head.getByText("휴직", { exact: true })).toBeVisible();
  expect(c.done("place on leave")).toBeLessThanOrEqual(5);
  const onLeave = await hrMenu(admin);
  await expect(hrItem(onLeave, "전보")).toHaveAttribute("aria-disabled", "true");
  await expect(hrItem(onLeave, "승진 처리")).toHaveAttribute("aria-disabled", "true");
  await admin.keyboard.press("Escape");
  // Exit is not an HR action here: it goes through an exit case (report → HR → HQ confirmation).
  await admin.getByRole("navigation", { name: "인사카드 탭" }).getByRole("link", { name: "인사카드", exact: true }).click();
  await expect(admin.getByRole("button", { name: "퇴직 보고", exact: true })).toBeVisible();

  await go(admin, "/people");
  await expect(admin.getByRole("row", { name: /정하늘/ })).toContainText("휴직");
  await expect(admin.getByRole("row", { name: /정하늘/ })).toContainText(/복귀 예정 · 2027\. 0?3\. 31\./); // the row's next item: the leave's expected return
  await expectAccessible(admin, "people list");
  await admin.goBack();
  await hrAct(admin, "복직 처리", c.click);
  const ret = sheet(admin, "정하늘 복직 처리");
  await c.click(todayPreset(ret));
  await reasonBox(ret).fill("육아 휴직 종료");
  await expect(ret.getByRole("checkbox")).toHaveCount(0); // BW-11 A13: no statement to tick
  await c.click(ret.getByRole("button", { name: "오늘 복직 처리", exact: true }));
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /정하늘을 복직 처리했습니다/ })).toBeVisible();
  await expect(head.getByText("재직", { exact: true })).toBeVisible();
  expect(c.done("return from leave")).toBeLessThanOrEqual(4);
  const back = await hrMenu(admin);
  await expect(hrItem(back, "전보")).not.toHaveAttribute("aria-disabled");
  await admin.keyboard.press("Escape");

  // 5c. A contract employee, registered from the department, then renewed.
  await go(admin, "/org");
  await revealUnit(admin, "인사부");
  await c.click(admin.getByRole("complementary", { name: "인사부", exact: true }).getByRole("link", { name: "인사부에 직원 등록" }));
  await fillRegister(admin, { name: "한가람", number: "HK-0101", hired: kstDate(), contractEnd: "2026-12-31", phone: "010-1234-0051" }, c);
  await pressRegister(admin, false, c);
  await expect(receiptOf(admin, "한가람")).toBeVisible();
  await openRegistered(admin, "한가람", "HK-0101");
  await expect(admin.getByRole("heading", { name: /한가람/ })).toBeVisible();
  // Link + 사번 + date + type + register (the unit came with the link).
  expect(c.done("register contract employee")).toBeLessThanOrEqual(6);

  await hrAct(admin, "계약 갱신", c.click);
  const renewal = sheet(admin, "한가람 계약 갱신");
  await c.click(todayPreset(renewal));
  await fillDate(renewal, "2027-12-31", "새 계약 종료일");
  await reasonBox(renewal).fill("계약 1년 연장");
  await expect(renewal.getByRole("checkbox")).toHaveCount(0); // BW-11 A13: no statement to tick
  await c.click(renewal.getByRole("button", { name: "오늘 계약 갱신", exact: true }));
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /한가람의 계약을 .+까지 갱신했습니다/ })).toBeVisible();
  expect(c.done("renew contract")).toBeLessThanOrEqual(4);

  // 6. Roster import binds rows to existing units by name.
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "roster.xlsx", await rosterXlsx("한결물산", [["HK-0002", "윤바다", "인사부", "사원", "2026-01-05"]]));
  await payPeriod(admin);
  await c.click(admin.getByRole("button", { name: "명부 미리보기" }));
  await c.click(admin.getByRole("button", { name: "모의 반영 실행" }));
  await c.click(admin.getByRole("button", { name: "명부 반영: 신규 1명 · 갱신 0명" }));
  await expect(admin.getByRole("heading", { name: "반영했습니다" })).toBeVisible();
  expect(c.done("import roster")).toBeLessThanOrEqual(3);

  // Imported employee opens (no employment profile yet → shown as 미등록, not an error).
  await c.click(admin.getByRole("link", { name: "직원 보기" }));
  await c.click(admin.getByRole("rowheader", { name: "윤바다", exact: true }));
  await c.click(admin.getByRole("complementary", { name: "직원 상세" }).getByRole("link", { name: "인사카드 열기" }));
  await expect(admin.getByRole("region", { name: "재직·배치" }).getByText("정보 미입력")).toBeVisible();
  await expectAccessible(admin, "imported employee page");
  c.done("open imported employee");

  // 7. Exit: report, then HR confirmation with the settlement sign-offs exits the employee.
  await c.click(admin.getByRole("button", { name: "퇴직 보고" }));
  await admin.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(0));
  await admin.getByLabel("퇴직 경위").fill("개인 사유 퇴직");
  await c.click(admin.getByRole("dialog").getByRole("button", { name: "퇴직 보고" }));
  await c.click(admin.getByRole("button", { name: "인사 확인하고 퇴직 처리" }));
  await expectAccessible(admin, "exit: HR confirmation dialog");
  await signOff(admin.getByRole("dialog"), c.click);
  await c.click(admin.getByRole("dialog").getByRole("button", { name: "인사 확인하고 퇴직 처리" }));
  await expect(admin.getByRole("dialog")).toBeHidden();
  await expect(admin.getByRole("heading", { name: /윤바다/, level: 1 }).locator("..").getByText("퇴직")).toBeVisible();
  expect(c.done("exit employee")).toBeLessThanOrEqual(12);
});
