import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook } from "../helpers/import";
import { rrn, workbook } from "../helpers/import-layouts";
import { apiOf, bearerOf } from "../helpers/api";

// regression (r3:hire-16, records-02): 성별, 계약종료일 and 수습종료일 were 「가져오지 않음」 and 직급 overwrote 직위, so every
// imported person's 근로자 명부 read 성별 빠짐 although the 주민등록번호 states it. Now they are column targets, 성별 also
// comes from the 주민등록번호's gender digit, and the end of the import says what the 명부 still lacks.
test("import register facts: 성별 from its column or the 주민등록번호, 직급 apart from 직위, and the 명부 gaps at the end", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "regfacts", "명부상사", false, "명부 본점");
  const api = apiOf(admin, bearerOf(admin));
  const header = ["사번", "성명", "입사일", "성별", "주민등록번호", "직위", "직급", "종사 업무", "계약종료일", "수습종료일"];
  const lines = [
    header,
    ["RF-0001", "한여름", "2024-03-04", "여", "", "대리", "G3", "생산 관리", "2026-12-31", "2024-06-03"],
    ["RF-0002", "윤가을", "2024-03-04", "", rrn("1990-01-01", 1, 7), "과장", "G4", "품질", "", ""],
  ];
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "명부.xlsx", await workbook([{ name: "재직자", lines }]));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  const columns = admin.getByRole("table", { name: "열", exact: true });
  await expect(columns.getByRole("row").filter({ hasText: "성별" }).first()).toContainText("직원 정보로 반영", { timeout: 30_000 });
  await expect(columns.getByRole("row").filter({ hasText: "계약종료일" }).first()).toContainText("계약종료일");
  await expect(columns.getByRole("row").filter({ hasText: "직급" }).first()).not.toContainText("직위");
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  const apply = admin.getByRole("button", { name: "명부 반영: 신규 2명 · 갱신 0명" });
  await expect(apply).toBeEnabled({ timeout: 30_000 });
  await apply.click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });

  // The 명부 gaps: 성별 came in for both (column, then 주민등록번호); 주소 and 이력 are named with the way to fill them.
  const gaps = admin.getByRole("region", { name: "근로자 명부에 아직 빠진 항목" });
  await expect(gaps).toContainText("주소 2명");
  await expect(gaps).toContainText("이력 2명");
  await expect(gaps).not.toContainText("성별");
  await expect(gaps.getByRole("link", { name: "직원 목록에서 일괄 수정" })).toBeVisible();
  await expectAccessible(admin, "import: register gaps at the end");

  // 직위 is the 직위 column's, never the 직급's.
  const read = async (number: string) => ((await (await api(`/employees?employee_number=${number}`)).json()) as { items: { position?: string | null; job?: string | null }[] }).items[0];
  expect(await read("RF-0001")).toMatchObject({ position: "대리", job: "생산 관리" });
  expect(await read("RF-0002")).toMatchObject({ position: "과장", job: "품질" });
});
