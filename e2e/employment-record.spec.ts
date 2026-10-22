import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { kstDate, option, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { fillDate } from "./sheet";

// The employment record on the employee page (EMP-MODEL): the onboarding checklist leads to the form that records
// each missing item, facts are written with a test of what was read, a contract's required terms follow its kind,
// a correction is a new row, and the probation end is recorded once.
test("employment record: checklist to facts, a contract and its correction, probation end", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "facts", "기록상사");
  await registerEmployee(admin, { name: "한수습", number: "FA-0001", position: "사원", hired: kstDate(-120) });

  const onboarding = admin.getByRole("region", { name: "입사 준비" });
  const facts = admin.getByRole("region", { name: "고용 기록" });
  const contracts = admin.getByRole("region", { name: "근로계약" });
  await expect(onboarding.getByRole("listitem").filter({ hasText: "생년월일 등록" })).toContainText("남음");
  await expect(onboarding.getByRole("listitem").filter({ hasText: "4대보험 취득신고" })).toContainText("따로 확인");
  await expect(facts).toContainText("미등록");
  await expectAccessible(admin, "employee page with the employment record");

  // A missing item opens the form that records it.
  await onboarding.getByRole("button", { name: "생년월일 등록 기록" }).click();
  const form = facts.getByRole("form", { name: "고용 기록 수정" });
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "고용 기록 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("바뀐 내용이 없습니다");
  await fillDate(form, "1990-05-01", "생년월일");
  await form.getByLabel("업무 이메일").fill("hansusup@employment.example");
  await option(admin, "신분증 종류", "주민등록번호").click();
  await fillDate(form, kstDate(-1), "수습 종료일");
  await expectAccessible(admin, "employment record form");
  await form.getByRole("button", { name: "고용 기록 저장" }).click();
  await expect(form).toBeHidden();
  await expect(facts).toContainText("••••-••-••");
  await expect(facts).not.toContainText("1990");
  await expect(facts).toContainText("hansusup@employment.example");
  await expect(facts).toContainText("주민등록번호");
  await expect(onboarding.getByRole("listitem").filter({ hasText: "생년월일 등록" })).toContainText("완료");

  // The probation end is past: the clock asks for the end to be confirmed, once.
  await expect(facts).toContainText("종료 확인 필요");
  await facts.getByRole("button", { name: "수습 종료 확인" }).click();
  await expect(facts).toContainText("수습 종료를 확인했습니다");
  await expect(facts.getByRole("button", { name: "수습 종료 확인" })).toHaveCount(0);

  // A fixed-term contract needs its end and, as a labour contract, its weekly hours.
  await contracts.getByRole("button", { name: "계약 기록" }).click();
  const record = contracts.getByRole("form", { name: "계약 기록" });
  await record.getByLabel(/^계약 종류/).selectOption({ label: "기간제 근로계약" });
  // A contract that starts on the hire date settles the checklist item.
  await fillDate(record, kstDate(-120), "계약 시작일");
  await record.getByRole("textbox", { name: /^임금/ }).fill("3000000");
  await option(admin, "임금 단위", "월급").click();
  await record.getByRole("button", { name: "계약 기록" }).click();
  await expect(record).toContainText("이 값이 있어야 기록합니다");
  await fillDate(record, kstDate(364), "계약 종료일");
  await record.getByLabel(/^주 소정근로시간/).fill("40");
  await expectAccessible(admin, "contract form");
  await record.getByRole("button", { name: "계약 기록" }).click();
  await expect(record).toBeHidden();
  await expect(contracts.getByRole("listitem")).toHaveCount(1);
  await expect(contracts.getByRole("listitem")).toContainText("현재 계약");
  await expect(contracts.getByRole("listitem")).toContainText("주 40시간");
  await expect(onboarding.getByRole("listitem").filter({ hasText: "입사일부터의 근로계약 기록" })).toContainText("완료");

  // A correction is a new row; the corrected one leaves the live history and stays on request.
  await contracts.getByRole("button", { name: "정정", exact: true }).click();
  const fix = contracts.getByRole("form", { name: /^계약 정정/ });
  await fix.getByRole("textbox", { name: /^임금/ }).fill("3200000");
  await fix.getByRole("button", { name: "정정 기록" }).click();
  await expect(fix).toBeHidden();
  await expect(contracts.getByRole("listitem")).toHaveCount(1);
  await expect(contracts.getByRole("listitem")).toContainText("정정 기록");
  await expect(contracts.getByRole("listitem")).toContainText("3,200,000");
  await contracts.getByRole("button", { name: "정정된 기록 1건 보기" }).click();
  await expect(contracts.getByRole("listitem")).toHaveCount(2);
  await expect(contracts.getByRole("listitem").filter({ hasText: "정정됨" })).toContainText("3,000,000");
  await expectAccessible(admin, "contract history with a correction");
});
