import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { box } from "./structure-flows";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { chooseRadio, option } from "./flows";
import { addWorkplaceFromEntity, openUnit, panel, sheet } from "./helpers/structure";
import { pickKind, tenantInSetup, typeAddress } from "./setup-flows";
test.beforeAll(() => loadCatalog("ko"));

// S5 사업장 (final spec §1 S5, §4): the add sheet asks 종류 · 원천징수 · 4대보험 with nothing preselected and says
// what is missing until they are answered; the panel shows the 4 insurance numbers apart; 대표 사업장 변경 is one
// operation naming the current holder; a setup 삭제 removes a mistaken 사업장. Everything from an empty tenant.

test("사업장: add with no defaults, the panel, change the representative workplace, delete in setup", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "wpstruct", "사업장구조");
  const c = clickCounter();

  // 1. The sheet opens on its 법인; nothing is chosen and the primary says why it cannot add yet (D7).
  const add = await addWorkplaceFromEntity(admin, /사업장구조/);
  await expect(add.getByRole("radio", { checked: true })).toHaveCount(0);
  const save = add.getByRole("button", { name: "사업장 추가", exact: true });
  await expect(save).toHaveAttribute("aria-disabled", "true");
  // company-38: the foot names exactly the items still open.
  await expect(save).toHaveAccessibleDescription(/^남은 항목: 사업장 이름 · 종류 · 원천징수 신고 · 4대보험/);
  await expectAccessible(admin, "add workplace sheet (initial)");
  c.done("open the add sheet");

  // 2. No certificate yet (linked later), 원천징수 with the head office, 4대보험 under the head office's numbers.
  await add.getByLabel("사업장 이름").fill("판교지점");
  await pickKind(add, c, "지점");
  await c.click(add.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText("본점(본점)에서 함께 신고"));
  await c.click(option(admin, "4대보험", "본사(주된 사업장) 번호로 함께"));
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await c.select(add.getByLabel("어느 사업장 번호로"), "본점 · 같은 법인");
  // A 사업장 with no certificate needs its address on this server (the mockup leaves it to a to-do: backend ask).
  await expect(save).toHaveAccessibleDescription("남은 항목: 소재지");
  await typeAddress(admin, "소재지", "경기도 성남시 분당구 판교역로 166", "13529", c);
  await expect(add).toContainText("추가하면 주식회사 사업장구조 아래 판교지점 상자가 바로 생기고");
  await expect(add).toContainText(t("workplace.create.todo.registration"));
  await expectAccessible(admin, "add workplace sheet (answered)");
  await c.click(save);
  await expect(add).toBeHidden();
  // §4 counts 6 for a first 사업장 (kind → mode → 원천징수 → 4대보험 → add); this one adds the joint pick and the
  // typed address (2).
  expect(c.done("a 사업장 with no certificate, reported with the head office")).toBeLessThanOrEqual(8);

  // 3. The panel: counts, facts with their verbs (개설일 is 정정만), the insurance unit, actions with consequences.
  const pangyo = await openUnit(admin, "판교지점");
  await expect(pangyo.getByRole("definition").filter({ hasText: "본점 번호로 함께 신고" })).toBeVisible();
  await expect(pangyo.getByText("정정만")).toBeVisible();
  await expect(pangyo.getByRole("button", { name: "부서 추가" })).toHaveAccessibleDescription("판교지점 바로 아래에 부서가 생깁니다");
  await expectAccessible(admin, "workplace panel");

  // 4. 대표 사업장 변경: the current holder is named and cannot be picked; nothing is preselected (≤ 3 clicks, §4).
  await c.click(pangyo.getByRole("button", { name: "본점 · 대표 수정", exact: true }));
  const primary = sheet(admin, "대표 사업장 변경");
  await expect(primary.getByRole("radio", { name: /^본점/ })).toBeDisabled();
  await expect(primary.getByRole("radio", { checked: true })).toHaveCount(0);
  await expectAccessible(admin, "change representative workplace");
  await c.click(chooseRadioTarget(primary));
  await expect(primary).toContainText("대표 사업장을 본점에서 판교지점으로 변경합니다.");
  await c.click(primary.getByRole("button", { name: "대표 사업장 변경" }));
  await expect(primary).toBeHidden();
  await expect(pangyo.getByRole("definition").filter({ hasText: /^대표 사업장$/ })).toBeVisible();
  expect(c.done("change the representative workplace")).toBeLessThanOrEqual(3);

  // 5. A 사업장 entered by mistake is deleted in setup, with a reason; it leaves the chart.
  const extra = await addWorkplaceFromEntity(admin, /사업장구조/);
  await extra.getByLabel("사업장 이름").fill("연습사업장");
  await pickKind(extra);
  await extra.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/).click();
  await option(admin, "4대보험", "아직 없음").click();
  await typeAddress(admin, "소재지", "서울특별시 중구 세종대로 110", "04524");
  await expect(extra).toContainText("추가하면 주식회사 사업장구조 아래 연습사업장 상자가 바로 생기고", { timeout: 2000 });
  await extra.getByRole("button", { name: "사업장 추가", exact: true }).click();
  const practice = await openUnit(admin, "연습사업장");
  await practice.getByRole("button", { name: "삭제" }).click();
  const del = sheet(admin, "연습사업장 삭제");
  await expect(del.getByRole("button", { name: "연습사업장 삭제" })).toHaveAttribute("aria-disabled", "true");
  await chooseRadio(del, /^연습으로 넣음/);
  await expectAccessible(admin, "delete workplace (setup)");
  await del.getByRole("button", { name: "연습사업장 삭제" }).click();
  await expect(del).toBeHidden();
  await expect(practice).toBeHidden();
  await expect(box(admin, "연습사업장")).toHaveCount(0);

  // 6. The first 사업장 is still reachable from the chart, its panel naming it the head office.
  const main = await openUnit(admin, "본점");
  await expect(main.getByRole("definition").filter({ hasText: /본점/ }).first()).toBeVisible();
});

const chooseRadioTarget = (scope: import("@playwright/test").Locator) => scope.getByRole("radio", { name: /^판교지점/ }).locator("xpath=ancestor::label[1]");
