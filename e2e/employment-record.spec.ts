import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { loadCatalog } from "@console/i18n";
import { trailItemLabel } from "../apps/web/src/features/people/present";
import { filingLabel } from "../apps/web/src/features/statutory/present";
import { expectAccessible } from "./a11y";
import { apiAs } from "./chaos";
import { kstDate, option, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { fillDate } from "./sheet";

test.beforeAll(() => loadCatalog("ko"));

// The hire trail reads the event's case; facts and contract corrections keep their own recorded histories.
test("employment record: hire trail, facts, a contract and its correction, probation end", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "facts", "기록상사");
  const read = apiAs(admin);
  await registerEmployee(admin, { name: "한수습", number: "FA-0001", position: "사원", hired: kstDate(-120) });

  const person = new URL(admin.url()).pathname.split("/").pop()!;
  type Case = components["schemas"]["LifecycleCase"];
  const hires = (await read<Case[]>(`/api/v1/employees/${person}/lifecycle-cases`)).filter((value) => value.kind === "HIRE");
  expect(hires).toHaveLength(1);
  const hire = hires[0]!;
  const trail = admin.getByRole("region", { name: "서류 · 법정 기한 · 할 일", exact: true });
  const facts = admin.getByRole("region", { name: "고용 기록" });
  const contracts = admin.getByRole("region", { name: "근로계약" });
  await expect(trail.getByRole("listitem")).toHaveCount(hire.items.length);
  for (const item of hire.items) {
    const label = item.filing_kind && item.insurer ? `${filingLabel(item.insurer)} ${filingLabel(item.filing_kind)}` : trailItemLabel(item.label_key, item.label);
    const row = trail.getByRole("listitem").filter({ hasText: label });
    await expect(row).toHaveCount(1);
    if (item.status_code === "PRE_CONSOLE") {
      await expect(row).toContainText("운영 시작 전");
      await expect(row).not.toContainText("기한 미확인");
      await expect(row.locator("time")).toHaveCount(0);
    } else if (item.due_rule_ref || item.opens_rule_ref) {
      await expect(row).toContainText("시작");
      await expect(row).toContainText("기한");
    } else {
      await expect(row).not.toContainText("시작 미확인");
      await expect(row).not.toContainText("기한 미확인");
    }
    if (item.status === "DONE_OBSERVED") await expect(row).toContainText("시스템 확인 완료");
  }
  await expect(admin.getByRole("region", { name: "입사 준비", exact: true })).toHaveCount(0);
  await expect(facts).toContainText("미등록");
  await expectAccessible(admin, "employee page with the employment record");

  await trail.getByRole("button", { name: "생년월일 등록 기록", exact: true }).click();
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
  await expect(trail.getByRole("listitem").filter({ hasText: "생년월일 등록" })).toContainText("시스템 확인 완료");
  await expect(trail.getByRole("listitem")).toHaveCount(hire.items.length);

  // The probation end is past: the clock asks for the end to be confirmed, once.
  await expect(facts).toContainText("종료 확인 필요");
  await facts.getByRole("button", { name: "수습 종료 확인" }).click();
  await expect(facts).toContainText("수습 종료를 확인했습니다");
  await expect(facts.getByRole("button", { name: "수습 종료 확인" })).toHaveCount(0);

  // A fixed-term contract needs its end and, as a labour contract, its weekly hours.
  await trail.getByRole("button", { name: "입사일부터의 근로계약 기록", exact: true }).click();
  const record = contracts.getByRole("form", { name: "계약 기록" });
  await record.getByLabel(/^계약 종류/).selectOption({ label: "기간제 근로계약" });
  // The contract begins on the recorded hire date.
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
  await expect(trail.getByRole("listitem").filter({ hasText: "입사일부터의 근로계약 기록" })).toContainText("시스템 확인 완료");
  expect((await read<Case[]>(`/api/v1/employees/${person}/lifecycle-cases`)).filter((value) => value.kind === "HIRE").map((value) => value.id)).toEqual([hire.id]);

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
