// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { resolveFilingNotApplicable } from "./helpers/statutory";
import { expectAccessible } from "./a11y";
import { fillRegister, openRegistered, pressRegister, receiptOf, registerSheet } from "./helpers/register";
import { clickCounter } from "./clicks";
import { tenantSlugField, chooseRadio, firstSignIn, go, kstDate, takeCode, unique, vendorPage } from "./flows";
import { cellOf, officeSchedule, openMonth } from "./helpers/attendance-records";
import { homeRail, registerBranch, registerEntity, registerWorkplace, startOperations, REGISTRATION_FIXTURES, brnDisplay } from "./setup-flows";
import { addDepartments, box, findBox, findPressable } from "./structure-flows";
import { rosterXlsx } from "./workbook";
import { gradeJourney } from "./helpers/grade-fix";
import { chooseWorkbook, payPeriod } from "./helpers/import";
import { expectComposer } from "./helpers/composer";

// The first-run solo gate (owner rule): one administrator, an empty tenant, no helper account. From the
// first sign-in to operating, every prerequisite is created through the product, in place, with no second
// person and no approval wait. Needs the backend's setup phase (branch hard/entity-depth, not yet merged).
// Clicks are counted per task (fills are typing, not clicks); each ceiling is the measured count + 2.

test("a solo administrator goes from an empty tenant to operating", { tag: "@first-run" }, async ({ browser }) => {
  const c = clickCounter();
  const companyDomain = unique("ganasol");
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await c.click(v.getByRole("button", { name: "고객 계정 개설" }));
  await v.getByLabel("고객 이름").fill("가나솔루션");
  await tenantSlugField(v).fill(companyDomain);
  await c.click(v.getByRole("button", { name: "개설하고 코드 발급" }));
  const code = await takeCode(v);
  expect(c.done("vendor: open the tenant and hand over the code")).toBeLessThanOrEqual(4);
  const admin = await firstSignIn(browser, code);
  await expect(admin.locator('a[href="/setup/company-names"]')).toHaveCount(0);
  await go(admin, "/setup/company-names", true);
  await expect(admin).toHaveURL(/\/org\/entities$/);
  await go(admin, "/");

  await admin.getByRole("link", { name: "회사 도메인", exact: true }).click();
  await expect(admin.getByText(`회사 도메인: ${companyDomain}`, { exact: true })).toBeVisible();
  await expect(admin.getByRole("button", { name: "변경 요청", exact: true })).toBeEnabled();
  await go(admin, "/");

  // Home leads with the server's setup rail; the first step is the certificate.
  const rail = await homeRail(admin);
  await expect(rail).toBeVisible();
  await expectAccessible(admin, "setup rail");
  await c.click(rail.getByRole("link", { name: "법인 등록" }).first());

  // 1. The legal entity and its first registration, typed beside no document.
  await registerEntity(admin, "가나솔루션", true, c);
  await expect(admin.getByText("홍길동", { exact: true }).first()).toBeVisible(); // 대표자 kept
  expect(c.done("legal entity + registration")).toBeLessThanOrEqual(BUDGET.entity);

  // 2. The first workplace: the certificate's own place, offered with its name prefilled.
  await go(admin, "/");
  const addWorkplace = rail.getByRole("link", { name: "사업장 등록" }).first();
  await expect(addWorkplace).toHaveAttribute("href", /\/workplaces\/new$/);
  await c.click(addWorkplace);
  await registerWorkplace(admin, "가나솔루션", "본사", true, c);
  expect(c.done("first workplace")).toBeLessThanOrEqual(BUDGET.workplace);

  // 3. A second workplace with its own (branch) registration, from the entity's page.
  await registerBranch(admin, "가나솔루션", "판교지점", REGISTRATION_FIXTURES.branch_primary.brn, false, c);
  await c.click(admin.getByRole("button", { name: /^사업장 2/ }));
  await expect(admin.getByRole("row", { name: new RegExp(`판교지점 .*${brnDisplay(REGISTRATION_FIXTURES.branch_primary.brn)}`) })).toBeVisible();
  await expectAccessible(admin, "entity workplaces");
  expect(c.done("second workplace (own registration)")).toBeLessThanOrEqual(BUDGET.branch);

  // 4. At least one 부서 is required before 운영 시작 (MVP requirement #4): the rail offers no skip, only 부서 추가.
  //    The org is built on the chart: select the 사업장 (one click), A, the name, Enter.
  await go(admin, "/");
  await expect(rail.getByRole("button", { name: "부서 없이 진행" })).toHaveCount(0);
  await c.click(rail.getByRole("link", { name: "부서 추가" }).first());
  await expect(admin).toHaveURL(/\/org(\?|$)/);
  await expect(admin.getByRole("dialog")).toHaveCount(0);
  for (const [place, unit] of [["본사", "영업팀"], ["판교지점", "개발팀"]] as const) {
    await findPressable(admin, place);
    await c.click(box(admin, place));
    await addDepartments(admin, place, [unit]);
  }
  await expectAccessible(admin, "setup org");
  // A person may still be placed straight on a 사업장: the register form offers it (no dead end).
  await go(admin, "/");
  await c.click(rail.getByRole("link", { name: "직원 등록" }).first());
  const probe = registerSheet(admin);
  const placement = probe.getByRole("combobox", { name: "둘 곳" });
  await placement.fill("판교");
  await expect(admin.getByRole("option", { name: /› 판교지점 \d+명$/ })).toBeVisible();
  // Dismiss the picker and sheet before reopening; rapid history changes can keep the probe mounted.
  await placement.press("Escape");
  await c.click(probe.getByRole("button", { name: "닫기", exact: true }));
  await expect(probe).toBeHidden();
  expect(c.done("org: two departments, applied at once")).toBeLessThanOrEqual(BUDGET.org);

  // 5. The first employee, placed by id: the one entity is a fact; the workplace is chosen (no default).
  await c.click(admin.getByRole("link", { name: "직원 등록", exact: true }).first());
  const sheet = registerSheet(admin);
  await expect(sheet.getByRole("combobox", { name: "둘 곳" })).toHaveValue("");
  await expect(sheet.getByRole("textbox", { name: /^이름/ })).toBeVisible();
  await expect(sheet.locator("details")).toHaveCount(0);
  await expect(sheet.getByText(/인사카드에서 채우도록 바뀔 예정/)).toHaveCount(0);
  await sheet.getByRole("textbox", { name: /^이름/ }).fill("김직원");
  // The commit is never dead (V4): the missing hire date is named and focused; placement can wait.
  await pressRegister(admin);
  await expect(sheet.getByRole("alert")).toContainText("수정해야 등록됩니다");
  await expect(sheet.getByRole("alert")).toContainText("1개를 수정해야 등록됩니다 · 입사일");
  await expect(sheet.getByRole("textbox", { name: /^입사일/ })).toBeFocused();
  await fillRegister(admin, { name: "김직원", unit: "영업팀", hired: kstDate() }, c);
  await expectAccessible(admin, "register employee (placement)");
  await pressRegister(admin, false, c);
  await expect(receiptOf(admin, "김직원")).toBeVisible();
  await openRegistered(admin, "김직원");
  await expect(admin.getByRole("heading", { name: /김직원/, level: 1 })).toBeVisible();
  // The employer of record and the workplace, read back by id.
  await expect(admin.getByRole("group", { name: "소속", exact: true }).getByRole("link", { name: "주식회사 가나솔루션" })).toBeVisible(); // the head's 소속, not the placement history's same link
  await expect(admin.getByRole("group", { name: "소속", exact: true }).getByRole("link", { name: "본사" })).toBeVisible(); // the head's 소속, not the placement history's same link
  expect(c.done("register one employee")).toBeLessThanOrEqual(BUDGET.employee);

  await gradeJourney(admin);
  await go(admin, "/statutory");
  const filing=admin.getByRole("row").filter({hasText:"김직원"}).filter({hasText:"국민연금"});
  await expect(filing).toContainText("가능일");
  await expect(filing).toContainText("목표");
  await resolveFilingNotApplicable(admin,filing);
  await admin.getByRole("button",{name:"처리 내역",exact:true}).click();
  await expect(filing).toContainText("미해당");
  await expect(filing.getByText("신고일",{exact:true})).toHaveCount(0);

  // 6. A roster import while still in setup.
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "roster.xlsx", await rosterXlsx("가나솔루션", [["GN-0101", "이개발", "개발팀", "선임", "2025-04-01"]]));
  await payPeriod(admin);
  await c.click(admin.getByRole("button", { name: "명부 미리보기" }));
  await c.click(admin.getByRole("button", { name: "모의 반영 실행" }));
  await c.click(admin.getByRole("button", { name: "명부 반영: 신규 1명 · 갱신 0명" }));
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible();
  expect(c.done("import a roster")).toBeLessThanOrEqual(BUDGET.import);

  // 7. Go-live: the terms are accepted in place, the sole-approver fact is confirmed, and the passkey signs it.
  await go(admin, "/");
  await c.click(rail.getByRole("link", { name: "이용약관 동의" }));
  await expect(admin.getByRole("heading", { name: "운영 시작", level: 1 })).toBeVisible();
  await startOperations(admin, true, c);
  expect(c.done("운영 시작")).toBeLessThanOrEqual(BUDGET.golive);

  // 8. Operating, alone: an org change is recorded and applies at once (decisions #26: no 결재 by default, so a solo
  // HR worker is never stuck waiting for an approver who does not exist); it stays on record with its reason.
  // On the chart the same gesture as in setup (select, A) opens the change sheet.
  await go(admin, "/org");
  await findPressable(admin, "본사");
  await c.click(box(admin, "본사"));
  await admin.keyboard.press("a");
  const selectedParent = new URL(admin.url()).searchParams.get("sel");
  const proposal = admin.getByRole("dialog", { name: "부서 신설" });
  await proposal.getByLabel("부서 이름").fill("마케팅팀");
  await c.click(proposal.getByRole("button", { name: /^오늘/ }));
  await proposal.getByLabel("사유").fill("마케팅 기능 신설");
  await expectComposer(proposal, "부서 신설 1개 반영");
  await c.click(proposal.getByRole("button", { name: "부서 신설 1개 반영" }));
  // org-19: the user stays on the chart; the receipt names the change and links its record.
  await expect.poll(() => new URL(admin.url()).searchParams.get("sel")).toBe(selectedParent);
  await expect(admin.getByRole("complementary", { name: "본사", exact: true })).toBeVisible();
  await expect(admin.getByRole("status").filter({ hasText: "마케팅팀 신설을 반영했습니다" }).first()).toBeVisible();
  c.done("org change after go-live: record and apply");
  // The chart opens at 사업장 depth; the find brings the new 부서 into view inside 본사.
  await findBox(admin, "마케팅팀");

  // A lone administrator records unusual attendance with evidence and an explicit acknowledgement.
  await officeSchedule(admin);
  const date = kstDate();
  const grid = await openMonth(admin, date.slice(0, 7));
  await cellOf(admin, "김직원", date).click();
  await admin.keyboard.type("5-23");
  await admin.keyboard.press("Enter");
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  const confirm = save.getByRole("checkbox", { name: /김직원.*5-23.*확인 기준 960분/ });
  await expect(confirm).not.toBeChecked();
  await chooseRadio(save, /출근부 \(종이\)/);
  await expect(save.getByRole("button", { name: /칸 저장/ })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "solo long record confirmation");
  await confirm.press("Space");
  await expect(confirm).toBeChecked();
  await save.getByRole("button", { name: "1칸 저장", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: "1칸을 저장했습니다" })).toBeVisible();
});

// Decision #7 case B (design §5.5), only where a tenant turns 결재 on (approval.policy.org_structure = route): with no
// other eligible holder, the drafter decides their own step after a passkey step-up, marked SOLE_HOLDER. MR-3 is
// parked with APPR (decisions #26), so this waits for it.
test.fixme("a solo administrator decides a governed change through the sole-holder fallback", async () => {});

// The roster import placing each person at a 법인 and 사업장 (by their 부서, MR-7) is proven in
// e2e/import/two-entities.spec.ts, read back on the employee record.

// Measured 2026-10-03 against hard/entity-depth 48de4cf (each + 2): entity 8, workplace 4, branch 11, org 7, employee 4, import 4, go-live 4.
const BUDGET = { entity: 15, workplace: 6, branch: 13, org: 9, employee: 6, import: 6, golive: 6 };
