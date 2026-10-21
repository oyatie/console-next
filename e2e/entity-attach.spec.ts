import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { REGISTRATION_FIXTURES, pickKind, registerEntity, registerWorkplace, typeAddress, workplaceSheet, brnDisplay } from "./setup-flows";

// UX-R1 ENTITY org-03 (P0, catalog company-18), from an empty tenant through the UI: a 사업장 added with 「나중에 연결」
// had no screen to get its 등록증, so a solo admin with people there could never start operations. Red on the parent FE
// (no 「등록증 연결」 anywhere: not on /org/entities where the go-live blocker lands, not on the 사업장).

/** A 법인 with its 본사 (on its own 등록증) and 평택공장 added with 「나중에 연결」. Ends on /org. */
async function entityWithUnattached(page: Page) {
  await go(page, "/org/entities/new");
  await registerEntity(page, "새온정밀");
  const record = page.url();
  await page.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(page, "새온정밀", "서울 본사");
  await go(page, new URL(record).pathname);
  await page.getByRole("link", { name: "사업장 추가" }).first().click();
  const sheet = workplaceSheet(page);
  await sheet.getByLabel("사업장 이름").fill("평택공장");
  await option(page, "사업자등록", "나중에 연결").click();
  await typeAddress(page, "소재지", "경기도 평택시 포승읍 평택항로 1", "17960");
  await pickKind(sheet);
  await sheet.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/).click();
  await option(page, "4대보험", "모두 성립 · 번호는 나중에").click();
  await sheet.getByRole("button", { name: "사업장 추가", exact: true }).click();
  await expect(sheet).toBeHidden();
}

/** The workplace's own certificate, typed as printed in the attach sheet (a second one: VAT is filed per workplace). */
async function typeOwnCertificate(page: Page, sheet: ReturnType<Page["getByRole"]>) {
  await option(page, "사업자등록", "이 사업장의 등록증").click();
  await sheet.getByLabel("사업자등록번호").fill(REGISTRATION_FIXTURES.branch_primary.brn);
  await sheet.getByLabel("법인명(단체명)").fill("주식회사 새온정밀 평택공장");
  await sheet.getByLabel("개업연월일").fill("2021-05-03");
  await typeAddress(page, "사업장 소재지", "경기도 평택시 포승읍 평택항로 1", "17960");
  await sheet.getByRole("textbox", { name: /^업태/ }).fill("제조업");
  await sheet.getByRole("textbox", { name: /^종목/ }).fill("정밀기기");
  await option(page, "사업자 단위 과세 적용", "적용 안 함").click();
  await sheet.getByLabel("과세유형").selectOption({ label: "일반과세자" });
  await sheet.getByLabel("관할 세무서 (등록증 표기)").fill("평택세무서");
  await option(page, "부가가치세 신고 단위", "사업장별").click();
}

test("a 사업장 added without a 등록증 gets its own from where the go-live blocker lands", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "uxr1-attach", "새온그룹");
  await entityWithUnattached(a);

  // The go-live blocker's link lands on /org/entities: the remedy is there, named by 사업장.
  await go(a, "/org/entities");
  const card = a.getByRole("region", { name: "등록증을 연결하지 않은 사업장" });
  await expect(card).toContainText("평택공장");
  await expectAccessible(a, "entities: workplaces with no registration");
  await card.getByRole("button", { name: "평택공장 등록증 연결" }).click();
  const sheet = a.getByRole("dialog", { name: "평택공장 등록증 연결" });
  await expect(sheet.getByRole("button", { name: "등록증 연결" })).toHaveAttribute("aria-disabled", "true");
  await typeOwnCertificate(a, sheet);
  // The link dates from the certificate's 개업연월일 unless another day is chosen.
  await expect(sheet.getByRole("textbox", { name: /^언제부터/ })).toHaveValue("2021-05-03");
  await expectAccessible(a, "attach registration sheet");

  // Negative: the server refuses the link (a date it cannot take); the words name the field and nothing is linked.
  await a.route(/\/api\/v1\/workplaces\/[0-9a-f-]{36}\/registration-changes$/, async (r) => {
    await r.fallback({ postData: JSON.stringify({ ...r.request().postDataJSON(), effective_from: "2999-01-01" }) });
  });
  const refused = a.waitForResponse((r) => /registration-changes$/.test(r.url()));
  await sheet.getByRole("button", { name: "등록증 연결" }).click();
  expect((await refused).status()).toBe(422);
  await expect(sheet.getByRole("alert")).not.toContainText("요청을 처리하지 못했습니다");
  await expect(sheet.getByRole("alert")).toBeVisible();
  await a.unroute(/\/api\/v1\/workplaces\/[0-9a-f-]{36}\/registration-changes$/);

  // The retry records the certificate once (its step key) and links it.
  const creates: string[] = [];
  a.on("request", (q) => q.method() === "POST" && /\/registrations$/.test(q.url()) && creates.push(q.url()));
  await sheet.getByRole("button", { name: "등록증 연결" }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
  expect(creates).toEqual([]);
  await expect(card).toBeHidden();

  // The 사업장 now files under its own 등록증, from the 법인 › 사업장 tab too.
  await a.getByRole("row", { name: /새온정밀/ }).click();
  await a.getByRole("button", { name: /^사업장 \d/ }).click();
  await a.getByRole("row", { name: /평택공장/ }).click();
  await expect(a.getByRole("complementary", { name: "평택공장" })).toContainText(brnDisplay(REGISTRATION_FIXTURES.branch_primary.brn));
});
