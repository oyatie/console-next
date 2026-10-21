import ExcelJS from "exceljs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go } from "./flows";
import { tenantInSetup } from "./setup-flows";

// S7 조직 시트 가져오기 from an empty tenant, through the UI only: an .xlsx read in the browser, its columns mapped by
// header (a 부서코드 column kept as the code, r3 org-06), every value that is not an exact name picked by hand (an unknown
// 법인 spelling, a 사업장 differing only in spacing, a new 사업장), a row with no 사업장 counted as an error, and the
// import applied without it — one undo for all of it, listed in the history.

const ENTITY = "새온정밀";
const radio = (scope: Page | Locator, group: string, name: string) => scope.getByRole("radiogroup", { name: new RegExp(group) }).getByText(name, { exact: true });

async function sheet(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("부서");
  for (const r of [
    ["회사", "근무지", "본부", "팀", "부서코드", "비고"],
    [`주식회사 ${ENTITY}`, "서울 본사", "경영지원본부", "인사팀", "HQ-HR", ""],
    [ENTITY, "서울 본사", "경영지원본부", "재무팀", "HQ-FI", ""],
    [`주식회사 ${ENTITY}`, "서울본사", "영업본부", "해외영업팀", "", ""],
    [`주식회사 ${ENTITY}`, "평택공장", "생산부", "생산1팀", "", "11월 개설"],
    [`주식회사 ${ENTITY}`, "", "", "총무팀", "", ""],
  ])
    ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("import an org sheet: columns, exact-only values, preview with an error row, apply and undo @org", async ({ browser }) => {
  const { admin: page } = await tenantInSetup(browser, "orgimport", ENTITY, false, "서울 본사");
  const c = clickCounter();
  await go(page, "/org/import");
  await expect(page.getByRole("heading", { name: "조직 시트 가져오기", level: 1 })).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await c.click(page.getByRole("button", { name: "파일 선택" }));
  await (await chooser).setFiles({ name: "새온정밀_조직표.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await sheet() });

  // Columns: matched by header; the code column is kept as the 부서 코드 (r3 org-06: never 「저장할 곳이 없어」).
  await expect(page.getByText("새온정밀_조직표.xlsx · 시트 “부서” · 5행")).toBeVisible();
  await expect(page.getByLabel("부서코드 열")).toHaveValue("code");
  await expect(page.getByText(/저장할 곳이 없어/)).toHaveCount(0);
  await expect(page.getByText("빈 칸은 건너뛰어 왼쪽부터 “경영지원본부 › 인사팀”처럼 잇습니다")).toBeVisible();
  await expect(page.getByText("열 6개 중 5개를 가져옵니다 (부서 경로 열 2개는 경로 하나로).")).toBeVisible();
  await expectAccessible(page, "org import columns");
  await c.click(page.getByRole("button", { name: "다음: 값 연결" }));

  // Values: nothing similar is guessed; each open value is a pick with nothing preselected.
  const next = page.getByRole("button", { name: "다음: 미리보기" });
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("선택할 항목 4개를 선택하면 미리보기로 갑니다")).toBeVisible();
  await expect(page.getByText("이름이 같은 사업장이 없습니다 · 띄어쓰기만 다른 사업장이 있습니다: 서울 본사")).toBeVisible();
  await expectAccessible(page, "org import values");
  await c.click(radio(page, `^주식회사 ${ENTITY} · 어디에`, `주식회사 ${ENTITY}`));
  await c.click(radio(page, `^${ENTITY} · 어디에`, `주식회사 ${ENTITY}`));
  await c.click(radio(page, "^서울본사 · 어디에", "서울 본사로 연결"));
  await c.click(radio(page, "^평택공장 · 어디에", `+ 새 사업장 “평택공장” 추가 · 주식회사 ${ENTITY} 아래`));
  await expect(page.getByText("모든 값을 맞췄습니다. 미리보기에서 추가될 모습을 확인합니다.")).toBeVisible();
  await c.click(next);

  // Preview: the row funnel, the new 사업장's questions first, the error row, and the tree.
  await expect(page.getByText("행 5 = 적용 4 + 오류 행 1")).toBeVisible();
  await expect(page.getByText("6행 · 사업장 칸이 비어 있습니다")).toBeVisible();
  const plan = page.getByRole("list", { name: "추가될 모습" });
  await expect(plan.getByRole("listitem").filter({ hasText: "서울 본사" })).toContainText("이미 있음 — 연결");
  await expect(plan.getByRole("listitem").filter({ hasText: "평택공장" })).toContainText("+ 신설 · 사업장");
  const apply = page.getByRole("button", { name: "오류 행 제외 후 적용 (4행)" });
  await expect(apply).toHaveAttribute("aria-disabled", "true");
  const card = page.getByRole("region", { name: `새 사업장 · 평택공장 · 주식회사 ${ENTITY}` });
  await c.click(radio(card, "원천징수 신고", "본점에서 함께 신고"));
  await c.click(radio(card, "4대보험", "본사(주된 사업장) 번호로 함께"));
  await c.click(radio(card, "번호를 함께 쓰는 주된 사업장", "서울 본사"));
  await c.click(card.getByRole("button", { name: "주소를 직접 입력" }));
  const addr = card.getByRole("group", { name: "주소", exact: true });
  await addr.getByLabel("도로명주소").fill("경기도 평택시 포승읍 평택항로 100");
  await addr.getByLabel("우편번호 (5자리)").fill("17962");
  await c.click(addr.getByRole("button", { name: "이 주소로 저장" }));
  await card.getByLabel("개설일").fill("2026-11-01");
  await expect(page.getByRole("button", { name: "8건 적용" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("오류 1건을 수정하거나, 오류 행만 제외하고 적용할 수 있습니다.")).toBeVisible();
  await expectAccessible(page, "org import preview");
  await c.click(apply);
  const receipt = page.getByRole("status").filter({ hasText: "기록됨" });
  await expect(receipt).toContainText("가져왔습니다 · 사업장 1곳 · 부서 7개를 추가했습니다");
  c.done("org sheet import");

  // The history lists both receipts; one 되돌리기 on the receipt undoes the whole import.
  await receipt.getByRole("button", { name: "되돌리기" }).click();
  await expect(receipt).toContainText("되돌렸습니다");
  await receipt.getByRole("link", { name: "변경 내역" }).click();
  const table = page.getByRole("table", { name: "조직도 변경 내역" });
  await expect(table.getByRole("cell", { name: "되돌림", exact: true })).toHaveCount(2);
});
