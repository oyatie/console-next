import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, kstDate } from "../flows";
import { SETUP_DEPARTMENT, startOperations, tenantInSetup } from "../setup-flows";
import { chooseWorkbook, payPeriod } from "../helpers/import";
import { plain, rrn, workbook } from "../helpers/import-layouts";

// A person's identifiers after an import (IMPORT-2, decisions #25), from an empty database through the UI: the
// 주민등록번호 masked, revealed once with a recorded reason and masked again; a 사번 변경 refused for a number someone
// holds, then recorded with its history; SETUP renumbering previewed, applied bound to the preview and undone; and
// after 운영 시작 renumbering closed, with why.

test("identifiers: masked 주민등록번호 revealed with a reason, 사번 변경 with history, SETUP renumbering and its undo, closed after go-live", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "identifiers", "한결", false, "한결 본점");
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "인사기록.xlsx", await workbook([plain("본사", [
    { number: "HJ-0101", name: "김민준", unit: SETUP_DEPARTMENT, position: "과장", hired: "2015-03-02", birth: "1985-04-12", rrn: rrn("1985-04-12", 1, 101) },
    { number: "HJ-0103", name: "이서연", unit: SETUP_DEPARTMENT, position: "대리", hired: "2018-01-15", birth: "1990-02-03", rrn: rrn("1990-02-03", 2, 103) },
  ])]));
  await payPeriod(admin);
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await admin.getByRole("button", { name: "명부 반영: 신규 2명 · 갱신 0명" }).click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });

  // 1. One person's identifiers: the masked number, revealed once with a reason; a 사번 변경 with its history.
  await go(admin, "/people");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("HJ-0103");
  await find.press("Enter");
  await expect(admin.getByRole("heading", { name: /이서연/, level: 1 })).toBeVisible();
  await admin.getByRole("link", { name: "사번·주민등록번호" }).click();
  const rrnCard = admin.getByRole("region", { name: "주민등록번호", exact: true });
  await expect(rrnCard).toContainText("••••••-•••••••");
  await rrnCard.getByRole("button", { name: "주민등록번호 보기 · 사유를 선택합니다" }).click();
  const reveal = admin.getByRole("dialog");
  await expect(reveal.getByRole("button", { name: "보기", exact: true })).toBeDisabled();
  await reveal.getByRole("radiogroup", { name: /왜 봅니까/ }).getByText("본인 확인", { exact: true }).click();
  await reveal.getByRole("button", { name: "보기", exact: true }).click();
  await expect(rrnCard.getByText(/^\d{6}-\d{7}$/)).toBeVisible();
  await rrnCard.getByRole("button", { name: "가리기" }).click();
  await expect(rrnCard).toContainText("••••••-•••••••");
  const numberCard = admin.getByRole("region", { name: "사번", exact: true });
  await numberCard.getByRole("button", { name: "사번 변경", exact: true }).click();
  await numberCard.getByLabel(/^새 사번/).fill("HJ-0101");
  await numberCard.getByLabel(/^적용일/).fill(kstDate());
  await numberCard.getByRole("radiogroup", { name: /변경 사유/ }).getByText("입력 오류", { exact: true }).click();
  await numberCard.getByRole("button", { name: "사번 변경 기록" }).click();
  await expect(numberCard.getByRole("alert")).toContainText("다른 직원이 쓰고 있거나 썼던 사번입니다");
  await numberCard.getByLabel(/^새 사번/).fill("HJ-9103");
  await numberCard.getByRole("button", { name: "사번 변경 기록" }).click();
  await expect(numberCard.getByRole("row").filter({ hasText: "HJ-0103 → HJ-9103" })).toContainText("입력 오류");
  await expectAccessible(admin, "identifiers: number changed, number masked");

  // 2. SETUP renumbering: preview, apply bound to the preview, undo; after 운영 시작 it is closed, with why.
  await go(admin, "/people/numbering");
  const renumber = admin.getByRole("region", { name: "사번 일괄 재부여" });
  await renumber.getByLabel(/^재부여할 범위/).selectOption({ label: "전체" });
  await renumber.getByLabel(/^새 사번 앞자리/).fill("HG-");
  await renumber.getByLabel(/^적용일/).fill(kstDate());
  await renumber.getByRole("radiogroup", { name: /재부여 사유/ }).getByText("사번 체계 변경", { exact: true }).click();
  await renumber.getByRole("button", { name: "새 사번 미리 보기" }).click();
  await expect(renumber).toContainText("겹치는 번호 0건");
  await expect(renumber.getByRole("grid", { name: "바뀔 사번" }).getByRole("row").filter({ hasText: "HJ-9103" })).toContainText("HG-");
  await expectAccessible(admin, "numbering: renumber preview");
  await renumber.getByRole("button", { name: /명 사번 재부여$/ }).click();
  await expect(renumber.getByRole("status").first()).toContainText("사번을 다시 부여했습니다");
  await renumber.getByRole("button", { name: "재부여 되돌리기" }).click();
  await expect(renumber).toContainText("사번을 예전으로 되돌렸습니다");
  await startOperations(admin);
  // The ruling keeps post-go-live imports without a department as warnings.
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "추가직원.xlsx", await workbook([plain("한결", [
    { number: "HJ-LATE1", name: "박추가", hired: kstDate() },
  ])]));
  await payPeriod(admin);
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await expect(admin.getByText(/미배치 1명/).first()).toBeVisible();
  await admin.getByRole("button", { name: "명부 반영: 신규 1명 · 갱신 0명" }).click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  await go(admin, "/people/numbering");
  await expect(admin.getByRole("region", { name: "사번 일괄 재부여" })).toContainText("운영을 시작한 뒤에는 일괄 재부여를 할 수 없습니다");
});
