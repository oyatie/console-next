import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go } from "./flows";
import { tenantInSetup } from "./setup-flows";

// S7 목록 붙여넣기 and S9 변경 내역 from an empty tenant, through the UI only: a list under a 법인 makes a new 사업장
// (its statutory questions answered, nothing preselected) and 부서 at any depth; a clash is renamed in place; one
// 되돌리기 undoes a whole commit; the history undoes the rest in order and says why a row cannot be undone.

const ENTITY = "새온바이오";
const radio = (scope: Locator, group: string, name: string) => scope.getByRole("radiogroup", { name: new RegExp(group) }).getByText(name, { exact: true });

async function typeAddress(scope: Locator, c: ReturnType<typeof clickCounter>) {
  const g = scope.getByRole("group", { name: "주소", exact: true });
  await c.click(scope.getByRole("button", { name: "주소를 직접 입력" }));
  await g.getByLabel("도로명주소").fill("충청북도 청주시 흥덕구 오송읍 오송생명로 200");
  await g.getByLabel("우편번호 (5자리)").fill("28160");
  await c.click(g.getByRole("button", { name: "이 주소로 저장" }));
}

const paste = (page: Page) => page.getByLabel("붙여넣은 내용");
const submit = (page: Page) => page.getByRole("button", { name: /개 추가$/ });
/** The receipt card (D18), not the polite announcement that repeats its first line. */
const receipt = (page: Page) => page.getByRole("status").filter({ hasText: "기록됨" });

test("paste a list under a 법인, undo it whole, and undo the rest from the history @org", async ({ browser }) => {
  const { admin: page } = await tenantInSetup(browser, "paste", ENTITY, false, "오송 본사");
  const c = clickCounter();

  // Where to paste: nothing preselected; the 법인 makes the first level 사업장.
  await go(page, "/org/paste");
  await c.click(radio(page.getByRole("main"), "어디 아래에", `주식회사 ${ENTITY}`));
  await paste(page).fill("오송 본사\n\t경영지원팀\n\t연구개발본부\n\t\t원료연구팀\n오송공장\t공장\n\t생산부\n\t\t원료생산1팀\n\t품질팀\n\t품질팀");
  await expect(page.getByText("알아낸 모양: 탭 들여쓰기 · 3단계 · 둘째 칸은 사업장 종류")).toBeVisible();
  const plan = page.getByRole("list", { name: "추가될 모습" });
  await expect(plan.getByRole("listitem").filter({ hasText: "오송 본사" })).toContainText("이미 있음 — 연결");
  await expect(plan.getByRole("listitem").filter({ hasText: "오송공장" })).toContainText("+ 신설 · 사업장");
  // The second 품질팀 under 오송공장 is a clash: nothing commits until it is renamed.
  await expect(page.getByRole("alert").filter({ hasText: "“품질팀” 이름이 두 번 있습니다" })).toBeVisible();
  await expect(submit(page)).toHaveAttribute("aria-disabled", "true");
  await page.getByLabel("9번째 줄 새 이름").fill("품질관리팀");
  await expect(page.getByRole("alert").filter({ hasText: "두 번 있습니다" })).toHaveCount(0);

  // The new 사업장 answers its questions; the commit waits for every one.
  const card = page.getByRole("region", { name: "새 사업장 · 오송공장" });
  await expect(card).toContainText("선택할 항목 4");
  await expectAccessible(page, "paste list (questions open)");
  await c.click(radio(card, "원천징수 신고", "본점에서 함께 신고"));
  await c.click(radio(card, "4대보험", "모두 성립 · 번호는 나중에"));
  await typeAddress(card, c);
  await card.getByLabel("개설일").fill("2026-10-01");
  await expect(card).toContainText("다 골랐습니다");
  await expect(page.getByText("사업장 1곳과 부서 7개를 추가합니다")).toBeVisible();
  await c.click(submit(page));
  await expect(receipt(page)).toContainText("사업장 1곳 · 부서 7개를 추가했습니다");
  // Spec §4 counts 5 with the paste itself; the address the server still requires adds 2 (직접 입력, 저장).
  expect(c.done("paste 1 사업장 + 7 부서")).toBeLessThanOrEqual(6);
  await expectAccessible(page, "paste receipt");

  // 15 부서 across the two 사업장 that now exist: both lines link, the commit is the only other click (spec §4: 2).
  await c.click(page.getByRole("button", { name: "다른 목록 붙여넣기" }));
  const depts = Array.from({ length: 7 }, (_, i) => `\t본사팀${i + 1}`).join("\n");
  const plant = Array.from({ length: 8 }, (_, i) => `\t공장팀${i + 1}`).join("\n");
  await paste(page).fill(`오송 본사\n${depts}\n오송공장\n${plant}`);
  await expect(submit(page)).toHaveText("부서 15개 추가");
  await c.click(submit(page));
  await expect(receipt(page)).toContainText("부서 15개를 추가했습니다");
  expect(c.done("paste 15 부서 across 2 사업장")).toBeLessThanOrEqual(2);
  // One 되돌리기 removes the whole commit.
  await page.getByRole("button", { name: "되돌리기" }).click();
  await expect(receipt(page)).toContainText("되돌렸습니다 · 이번에 추가한 것을 모두 삭제했습니다");
  // A 부서 under one the first list made: that list can no longer be undone before this one.
  await page.getByRole("button", { name: "다른 목록 붙여넣기" }).click();
  await paste(page).fill("오송 본사\n\t경영지원팀\n\t\t총무파트");
  await submit(page).click();
  await expect(receipt(page)).toContainText("부서 1개를 추가했습니다");

  // The history: newest first, each row with its undo or the reason it has none.
  await page.getByRole("link", { name: "변경 내역" }).click();
  await expect(page.getByRole("heading", { name: "조직도 변경 내역", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: "조직도 변경 내역" });
  const kind = (k: string) => table.getByRole("row").filter({ has: page.getByRole("cell", { name: k, exact: true }) });
  await expect(kind("되돌림")).toHaveCount(1);
  await expect(kind("되돌림")).toContainText("되돌린 기록");
  await expect(kind("적용").filter({ hasText: "부서 15개" })).toContainText("이미 되돌림");
  await expectAccessible(page, "org history");
  // Out of order the server refuses, and the row says why; in order every undo lands.
  const first = table.getByRole("button", { name: "경영지원팀, 연구개발본부 외 5개 되돌리기" });
  await first.click();
  await expect(table.getByRole("alert")).toContainText("추가한 부서에 하위 부서나 사람이 있습니다");
  await table.getByRole("button", { name: "총무파트 되돌리기" }).click();
  await expect(kind("되돌림")).toHaveCount(2);
  await first.click();
  await expect(kind("되돌림")).toHaveCount(3);
  await table.getByRole("button", { name: "법인·사업장 1건 되돌리기", disabled: false }).click();
  await expect(kind("되돌림")).toHaveCount(4);
  await page.getByRole("checkbox", { name: "되돌릴 수 있는 것만" }).check();
  await expect(page.getByRole("status").filter({ hasText: "조건에 맞는 변경이 없습니다." })).toBeVisible();
});
