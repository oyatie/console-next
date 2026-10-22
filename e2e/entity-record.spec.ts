import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go, kstDate, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { REGISTRATION_FIXTURES, registerEntity, SECOND, staffedTenant, brnDisplay } from "./setup-flows";

// The 법인 record (spec S3), from an empty tenant through the UI only: every fact with its one verb, 변경 vs 정정
// with nothing preselected (and the dated change shown as scheduled), a 정정만 fact, the 사업자등록번호 correction in
// setup (spec §4: 고치기 → reason → 번호 정정), and 법인 종료 after 운영 시작 with its blockers named first.

const sheet = (page: Page, name: string) => page.getByRole("dialog", { name });
const nextMonth = () => {
  const [y, m] = kstDate().split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};

test("the record: 변경 from a date, 정정 of the period in force, 정정만, and the BRN corrected in setup", { tag: "@org" }, async ({ browser }) => {
  const admin = await openTenant(browser, "cs-record", "새온그룹");
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "새온정밀");
  await expect(admin.getByRole("region", { name: "사업자등록증" })).toBeVisible();
  await expect(admin.getByText("진위 확인: 하지 않음").first()).toBeVisible();
  await expect(admin.getByRole("region", { name: "등기 · 법인 기본" })).toBeVisible();
  await expect(admin.getByRole("region", { name: "받지 않는 항목" })).toHaveCount(0);
  await expect(admin.getByText("개인정보 보호법 제24조의2")).toBeVisible();
  // Golden floor: the dated read keeps all printed certificate and registry fields, plus every record tab.
  for (const field of ["과세유형", "등록번호", "법인명(단체명)", "대표자", "개업연월일", "법인등록번호",
    "사업장 소재지", "본점 소재지", "사업의 종류", "발급 사유", "주류판매신고번호", "사업자 단위 과세",
    "전자세금계산서 메일", "발급일 · 세무서", "회사성립연월일", "자본금", "결산월", "대표 방식", "대표전화", "임원", "상호출자제한기업집단", "부가가치세 신고 단위", "주된 업종", "우선지원대상기업"])
    await expect(admin.getByText(field, { exact: true }).first()).toBeVisible();
  for (const tab of ["개요", "사업자등록증", "사업장", "임원", "문서", "이력"])
    await expect(admin.getByRole("group", { name: "법인 정보 보기" }).getByRole("button", { name: new RegExp(`^${tab}(?:\\s|$)`) })).toBeVisible();
  await expectAccessible(admin, "S3 entity record");

  // 변경: nothing is preselected and nothing saves until a verb and a date are chosen.
  await admin.getByRole("button", { name: "대표자 수정" }).click();
  const reps = sheet(admin, "대표자 수정");
  await expect(reps.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(reps.getByText("아직 아무것도 바뀌지 않았습니다 · 변경과 정정 중 하나를 선택하십시오.")).toBeVisible();
  await expect(reps.getByRole("button", { name: "기록", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "S3 revise sheet: initial");
  await option(admin, "무엇을 기록합니까", "대표자가 바뀌었습니다 · 변경").click();
  await expect(reps.getByRole("radiogroup", { name: /언제부터 바뀝니까/ }).getByRole("radio", { checked: true })).toHaveCount(0);
  await option(admin, "언제부터 바뀝니까", `다음 달 1일 (${nextMonth().slice(5)})`).click();
  await reps.getByRole("button", { name: "대표자 선임" }).click();
  await reps.getByLabel("새 대표자 1 이름").fill("한지원");
  await expect(reps.getByRole("button", { name: "변경 기록" })).toHaveAttribute("aria-disabled", "true");
  await option(admin, "대표 방식", "각자대표").click();
  await expect(reps.getByText("기간별로 보면")).toBeVisible();
  await expect(reps.getByText(/홍길동, 한지원 \(각자대표\)/).first()).toBeVisible();
  await expectAccessible(admin, "S3 revise sheet: chosen");
  await reps.getByRole("button", { name: "변경 기록" }).click();
  await expect(reps).toBeHidden();
  // Scheduled, not applied: today's record still reads 홍길동 alone, the history shows the change ahead.
  await expect(admin.getByRole("region", { name: "이력" }).getByText(/예정/).first()).toBeVisible();

  // 정정 records the period in force again, so the corrected value is what reads today.
  await admin.getByRole("button", { name: "대표전화 수정" }).click();
  const phone = sheet(admin, "대표전화 수정");
  await option(admin, "무엇을 기록합니까", "처음부터 잘못 적었습니다 · 정정").click();
  await phone.getByRole("textbox", { name: /^대표전화/ }).fill("025550142");
  await phone.getByRole("button", { name: "정정 기록" }).click();
  await expect(phone).toBeHidden();
  await expect(admin.getByText("02-555-0142").first()).toBeVisible();

  // 정정만: an opening date is only ever corrected, so the sheet skips the choice.
  await admin.getByRole("button", { name: "개업연월일 정정" }).click();
  const opened = sheet(admin, "개업연월일 수정");
  await expect(opened.getByText(/이 칸은 정정만 합니다/)).toBeVisible();
  await opened.getByRole("textbox", { name: /^개업연월일/ }).fill("2020-03-03");
  await opened.getByRole("button", { name: "정정 기록" }).click();
  await expect(opened).toBeHidden();

  // 식별번호 정정 in setup: 변경 is shown disabled with why; reason, then 번호 정정 (spec §4 ceiling, from the record).
  const c = clickCounter();
  await c.click(admin.getByRole("button", { name: "등록번호 수정", exact: true }));
  const brn = sheet(admin, "사업자등록번호 정정");
  await expect(brn.getByText(/사업자등록번호는 바뀌지 않는 번호라 선택할 수 없습니다/)).toBeVisible();
  await expect(brn.getByText(/변경하지 않음 · 공단 통지서와 대조하십시오/)).toBeVisible();
  await brn.getByLabel("올바른 번호").fill(REGISTRATION_FIXTURES.second.brn);
  await c.click(option(admin, "정정 사유", "입력 잘못"));
  // The evidence (one more click for a real user's file chooser).
  await brn.locator('input[type="file"]').setInputFiles({ name: "registration.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await expect(brn.getByText(/registration\.pdf 붙임/)).toBeVisible();
  await expectAccessible(admin, "S3 BRN correction");
  await c.click(brn.getByRole("button", { name: "번호 정정" }));
  await expect(brn).toBeHidden();
  expect(c.done("BRN typo (spec §4: 4; +1 file chooser)")).toBeLessThanOrEqual(3);
  await expect(admin.getByText(brnDisplay(REGISTRATION_FIXTURES.second.brn)).first()).toBeVisible();
});

test("법인 종료 after 운영 시작: blockers first and the date locked; a never-used 법인 is deleted instead", { tag: "@org" }, async ({ browser }) => {
  // Blocked: the operating tenant still has 부서 under its 법인.
  const staffed = await staffedTenant(browser, "cs-close-blocked", "새온리테일");
  await go(staffed.admin, "/org/entities");
  await staffed.admin.getByRole("row", { name: /새온리테일/ }).click();
  await staffed.admin.getByRole("button", { name: "법인 종료 계획 보기" }).click();
  const blocked = sheet(staffed.admin, "법인 종료");
  await expect(blocked.getByText(/먼저 끝내야 할 일/)).toBeVisible();
  await expect(blocked.getByText(/열린 부서 \d+개/)).toBeVisible();
  await expect(blocked.getByText(/종료일 · 위 \d+개를 처리하면 선택할 수 있습니다/)).toBeVisible();
  await expect(blocked.getByRole("button", { name: "법인 종료" })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(staffed.admin, "S3 close: blocked");

  // Never used: a second 법인 entered after go-live, no 사업장, no 부서, nobody ever placed — it is deleted, not closed
  // (CRUD: decided by use), and the record says why 폐업 is not the way. regression: only 「법인 종료 계획 보기」 was
  // offered after go-live. (A tenant's first 법인 always holds a 부서 by then: 운영 시작 requires one.)
  const { admin } = staffed;
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "새온바이오", false, undefined, SECOND);
  await go(admin, "/org/entities");
  await admin.getByRole("row", { name: /새온바이오/ }).click();
  await expect(admin.getByRole("button", { name: "법인 종료 계획 보기" })).toHaveCount(0);
  await admin.getByRole("button", { name: "법인 삭제 미리보기" }).click();
  const remove = admin.getByRole("dialog", { name: "법인 삭제" });
  await option(admin, "삭제 사유", "중복 등록").click();
  await remove.getByRole("button", { name: "법인 삭제" }).click();
  await expect(admin).toHaveURL(/\/org\/entities$/);
  await expect(admin.getByRole("row", { name: /새온바이오/ })).toHaveCount(0);
});
