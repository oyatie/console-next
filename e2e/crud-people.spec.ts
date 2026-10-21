import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { soloTenant } from "./chaos";
import { go, kstDate, option, registerEmployee } from "./flows";
import { openUnit } from "./helpers/structure";
import { setupCompany, startOperations } from "./setup-flows";
import { signOff } from "./sheet";
import { holdRead } from "./helpers/read";

// of the record's rail, and no screen offered 등록 취소 although the server served it.

/** The record's action row (정보 정정, 퇴직, 등록 취소). */
const actions = (page: Page) => page.getByRole("group", { name: "기록 정정" });

async function reportExit(page: Page, name: string, date: string) {
  await actions(page).getByRole("button", { name: "퇴직", exact: true }).click();
  // The 퇴직 report sheet (spec E5-exit): titled by the act, the person on its kicker line.
  const s = page.getByRole("dialog", { name: "퇴직 보고", exact: true }).filter({ hasText: name });
  await s.getByRole("textbox", { name: /^마지막 근무일/ }).fill(date);
  await s.getByLabel("퇴직 경위").fill("개인 사정");
  await s.getByRole("button", { name: /퇴직 보고$/ }).click();
  return s;
}

test("퇴직 from the record, refused where it must be, closed alone, and the person leaves the roster", { tag: ["@first-run", "@regression", "@hr"] }, async ({ browser }) => {
  const admin = await soloTenant(browser, "crudexit", "퇴직상사");
  await setupCompany(admin, "퇴직상사", "본사");
  await startOperations(admin);

  // A 퇴직일 before the 입사일 is refused in words and records nothing.
  await registerEmployee(admin, { name: "미래입사", number: "CX-0001", hired: kstDate(3), unit: "본사" });
  let s = await reportExit(admin, "미래입사", kstDate(0));
  await expect(s.getByRole("alert")).toContainText("퇴직일이 입사일보다 빠릅니다");
  await s.getByRole("button", { name: "취소", exact: true }).click();
  await expect(admin.getByRole("region", { name: "퇴직", exact: true })).not.toContainText("보고됨");

  // 퇴직 is in the record's action row, not only in the rail's card.
  await registerEmployee(admin, { name: "떠날사람", number: "CX-0002", hired: "2024-03-04", unit: "본사" });
  await expect(actions(admin).getByRole("button", { name: "퇴직", exact: true })).toBeVisible();
  await expectAccessible(admin, "CRUD: record with 퇴직 and 등록 취소");
  s = await reportExit(admin, "떠날사람", kstDate(0));
  await expect(s).toBeHidden();
  const exitPanel = admin.getByRole("region", { name: "퇴직", exact: true });
  await expect(exitPanel).toContainText("보고됨");
  // With the case open, 퇴직 is not offered again and 등록 취소 is refused (an exit case is a work record).
  await expect(actions(admin)).toContainText("진행 중인 퇴직 건이 있습니다");
  await expect(actions(admin)).toContainText("근무 기록(퇴직 건, 발령, 근태, 급여)이 있어 등록 취소하지 않습니다");
  await expect(actions(admin).getByRole("button", { name: "퇴직", exact: true })).toHaveAttribute("aria-disabled", "true");

  // The solo admin confirms for HR and for HQ (D26-FINISH: no second person under 결재 none).
  await exitPanel.getByRole("button", { name: "인사 확인하고 퇴직 처리" }).click();
  await signOff(admin.getByRole("dialog").getByRole("group", { name: "확인 사항" }));
  await admin.getByRole("dialog").getByRole("button", { name: /인사 확인하고/ }).click();
  await expect(admin.getByRole("dialog")).toBeHidden();
  await expect(exitPanel).toContainText("인사 확인됨");
  const caseHref = await exitPanel.getByRole("link", { name: "퇴직 건 열기" }).getAttribute("href");
  const employeeId = new URL(admin.url()).pathname.split("/").pop()!;
  await go(admin, caseHref!);
  // The case can show HQ's confirmation while another invalidated read still holds its receipt callback.
  const employeeRead = await holdRead(admin, `**/api/v1/employees/${employeeId}`);
  await admin.getByRole("region", { name: /지금/ }).getByRole("button", { name: "본사 퇴직 확인" }).click();
  await employeeRead.requested;
  await expect(admin.getByRole("region", { name: "퇴직" })).toContainText("본사 확인됨");

  // Out of the active roster and the headcount, findable under 퇴직.
  await go(admin, "/people");
  const employeeAnswer = admin.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/employees/${employeeId}`);
  await employeeRead.release(); // a late exit-page receipt must not navigate away from the roster
  await (await employeeAnswer).finished();
  await expect(admin).toHaveURL(/\/people$/);
  const table = admin.getByRole("grid");
  await expect(table).not.toHaveAttribute("data-state", "loading");
  await expect(table).not.toContainText("떠날사람");
  await admin.getByRole("group", { name: /상태/ }).getByRole("button", { name: /^퇴직( · 3년 보관)? \d/ }).click();
  await expect(table).toContainText("떠날사람");
  // 인원 is 재직 + 휴직 (design-language §인원): the leaver is out of it, and 미래입사 (입사 예정) is not counted in it.
  const hq = await openUnit(admin, "본사");
  await expect(hq.getByRole("heading", { name: "사업장 직속 0명", level: 3 })).toBeVisible();
});

test("등록 취소 for a mistaken registration, refused for a used one, and 퇴직 for several from the roster", { tag: ["@first-run", "@regression", "@hr"] }, async ({ browser }) => {
  const admin = await soloTenant(browser, "crudcancel", "취소상사");
  await setupCompany(admin, "취소상사", "본사");
  await startOperations(admin);

  // A registration nobody worked under: 등록 취소 from the record (attested; the solo holder's passkey).
  await registerEmployee(admin, { name: "잘못등록", number: "CC-0001", unit: "본사" });
  await actions(admin).getByRole("button", { name: "등록 취소" }).click();
  const s = admin.getByRole("dialog", { name: "잘못등록 등록 취소" });
  await expect(s).toContainText("운영 중 · 근무한 적 없는 등록만 취소합니다");
  // Negative: nothing goes until the reason and the attestation are given.
  await expect(s.getByRole("button", { name: "등록 취소", exact: true })).toHaveAttribute("aria-disabled", "true");
  await s.getByRole("button", { name: "등록 취소", exact: true }).click({ force: true });
  await expect(s).toBeVisible();
  await option(admin, "취소하는 이유", "같은 사람을 두 번 등록함").click();
  await s.getByText("이 사람은 근무한 적이 없습니다").click();
  await expect(admin.getByRole("main").getByText("불러오는 중…", { exact: true })).toBeHidden({ timeout: 15_000 });
  await expectAccessible(admin, "CRUD: 등록 취소 sheet");
  await s.getByRole("button", { name: "등록 취소", exact: true }).click();
  await expect(admin).toHaveURL(/\/people$/);
  // Gone from the roster (an empty company shows its first-run ways in, not an empty grid).
  await expect(admin.getByRole("row", { name: /잘못등록/ })).toHaveCount(0);

  // Two people, 퇴직 for both from the roster's selection: one report each, each answer listed.
  for (const [i, name] of ["갑순", "을순"].entries()) await registerEmployee(admin, { name, number: `CC-01${i}`, hired: "2024-03-04", unit: "본사" });
  await go(admin, "/people");
  for (const name of ["갑순", "을순"]) await admin.getByRole("row", { name: new RegExp(name) }).locator("label", { has: admin.getByRole("checkbox") }).click();
  await admin.getByRole("button", { name: "선택한 2명 퇴직" }).click();
  const bulk = admin.getByRole("dialog", { name: "2명 퇴직 보고" });
  await bulk.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(0));
  await bulk.getByLabel("퇴직 사유").fill("사업 정리");
  await bulk.getByRole("button", { name: "2명 퇴직 보고" }).click();
  await expect(bulk.getByRole("status")).toContainText("보고 2명 · 거절 0명");
  await expectAccessible(admin, "CRUD: bulk 퇴직 results");
  await bulk.getByRole("button", { name: "닫기", exact: true }).last().click();

  // The row's side panel: 퇴직 is refused for 갑순 now (open case), and 등록 취소 says why it is not offered.
  await admin.getByRole("button", { name: "선택 해제" }).click();
  await admin.getByRole("row", { name: /갑순/ }).getByRole("rowheader", { name: "갑순" }).click();
  const peek = admin.getByRole("complementary", { name: "직원 상세" }).filter({ hasText: "갑순" });
  await expect(peek).toContainText("진행 중인 퇴직 건이 있습니다");
  // Again from the selection: each refused with its reason, nothing recorded twice.
  for (const name of ["갑순", "을순"]) await admin.getByRole("row", { name: new RegExp(name) }).locator("label", { has: admin.getByRole("checkbox") }).click();
  await admin.getByRole("button", { name: "선택한 2명 퇴직" }).click();
  await bulk.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(0));
  await bulk.getByLabel("퇴직 사유").fill("다시");
  await bulk.getByRole("button", { name: "2명 퇴직 보고" }).click();
  await expect(bulk.getByRole("status")).toContainText("보고 0명 · 거절 2명");
  await expect(bulk).toContainText("진행 중인 퇴직 건이 있습니다");
});

test("an account without the permission sees 퇴직 and 등록 취소 refused with the reason, and nothing opens", { tag: ["@hr"] }, async ({ browser }) => {
  const admin = await soloTenant(browser, "crudperm", "권한상사");
  await setupCompany(admin, "권한상사", "본사");
  await startOperations(admin);
  await registerEmployee(admin, { name: "권한없음", number: "CP-0001", unit: "본사" });
  // The server's answer for a reader without the doors (403 on the writes is proven by the backend's route tests).
  await admin.route("**/end-options", async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    await r.fulfill({ response: res, json: { ...body, can_cancel: false, can_report_exit: false } });
  });
  await admin.reload();
  await expect(actions(admin)).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
  await expect(actions(admin).getByRole("button", { name: "등록 취소" })).toHaveAttribute("aria-disabled", "true");
  await actions(admin).getByRole("button", { name: "등록 취소" }).click({ force: true });
  await expect(admin.getByRole("dialog")).toHaveCount(0);
});
