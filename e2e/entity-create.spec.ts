import { expect, test, type Page } from "@playwright/test";
import { fillDate } from "./sheet";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { REGISTRATION_FIXTURES, registerEntity, CRN_BAD_CHECK } from "./setup-flows";

// 법인 추가 (spec S4), from an empty tenant through the UI only: the quick two-input sheet with its undo, the
// certificate wizard with its refusals (a taken BRN, a future opening date) and its one warning (the CRN check
// digit), and the 개인사업자 / 고유번호 단체 variants. Click ceilings are spec §4's, counted from the sheet's trigger
// on the 법인 list (the chart's root box belongs to the chart lane).

const sheet = (page: Page) => page.getByRole("dialog", { name: "법인 추가" });

test("quick add: three inputs, the receipt's undo, and a corporation sent on to the certificate", { tag: "@org" }, async ({ browser }) => {
  const admin = await openTenant(browser, "cs-quick", "새온그룹");
  const c = clickCounter();
  await go(admin, "/org/entities");
  await c.click(admin.getByRole("link", { name: "법인 추가" }));
  const s = sheet(admin);
  await expect(s.getByRole("radiogroup", { name: /^사업자 구분/ })).toBeVisible();
  await expect(s).not.toContainText("사업자 구분, 이름, 대표자 세 가지만 있으면 저장됩니다.");
  // Nothing is preselected, so nothing saves yet; the reason is the foot's sentence.
  await expect(s.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(s.getByRole("button", { name: "법인 등록", exact: true })).toHaveAttribute("aria-disabled", "true");
  await c.click(option(admin, "사업자 구분", "개인사업자"));
  await s.getByLabel("상호").fill("새온공방");
  await expect(s.getByLabel("상호")).toHaveValue("새온공방");
  await expect(s.getByText("다른 법인과 겹치지 않습니다")).toHaveCount(0);
  await s.getByLabel("성명").fill("이새온");
  await expectAccessible(admin, "S4 quick sheet");
  await c.click(s.getByRole("button", { name: "법인 등록", exact: true }));
  expect(c.done("quick 법인 (spec §4: 3)")).toBeLessThanOrEqual(3);
  await expect(s).toBeHidden();
  const receipt = admin.getByRole("status").filter({ has: admin.getByRole("button", { name: "되돌리기" }) });
  await expect(receipt).toContainText("새온공방을 등록했습니다");
  await expect(receipt).toBeVisible();
  await expect(admin.getByRole("row", { name: /새온공방/ })).toBeVisible();

  // The receipt's undo removes it again during setup.
  await receipt.getByRole("button", { name: "되돌리기" }).click();
  await expect(admin.getByRole("row", { name: /새온공방/ })).toBeHidden();

  // A corporation: the server still needs its CRN and head office, so the sheet says so and offers the certificate.
  await admin.getByRole("link", { name: "법인 추가" }).click();
  await option(admin, "사업자 구분", "법인사업자").click();
  await s.getByLabel("법인명(단체명)").fill("(주)새온바이오");
  await s.getByRole("textbox", { name: /^대표자/ }).fill("윤가온");
  await expect(s.getByText(/법인등록번호와 본점 소재지가 있어야/)).toBeVisible();
  await expect(s.getByRole("button", { name: "법인 등록", exact: true })).toHaveAttribute("aria-disabled", "true");
  await s.getByRole("button", { name: "등록증 보며 모두 입력" }).click();
  await expect(admin.getByRole("heading", { name: "법인 추가", level: 1 })).toBeVisible();
  // What the sheet chose is carried: the wizard opens on the certificate with kind and name set.
  await expect(admin.getByText("법인사업자 · (주)새온바이오")).toBeVisible();
  await expect(admin.locator('[aria-current="step"]')).toHaveText(/사업자등록증/);

  // 「법인 만들고 첫 사업장 추가」 goes straight to the new 법인's first 사업장.
  await go(admin, "/org/entities?add=true");
  await option(admin, "사업자 구분", "고유번호 단체").click();
  await s.getByLabel("명칭").fill("새온장학회");
  await s.getByRole("textbox", { name: /^대표자/ }).fill("박새온");
  await s.getByRole("button", { name: "법인 등록 후 첫 사업장 추가" }).click();
  // The old new-workplace address leads to the add sheet over 회사 구조, opened on this 법인.
  await expect(admin).toHaveURL(/\/org\?sel=[^&]+&act=wp-create$/);
  await expect(admin.getByRole("dialog", { name: "사업장 추가" })).toContainText("새온장학회");
});

test("the certificate wizard refuses a taken number and a future date, warns on the CRN, and saves the rest as to-dos", { tag: "@org" }, async ({ browser }) => {
  const admin = await openTenant(browser, "cs-wizard", "새온그룹");
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "새온정밀");

  const c = clickCounter();
  await go(admin, "/org/entities/new");
  await c.click(option(admin, "사업자 구분", "법인사업자"));
  await admin.getByLabel("법인명(단체명)").fill("(주)새온바이오");
  await c.click(admin.getByRole("button", { name: "다음", exact: true }));
  const foot = admin.getByText(/수정할 칸/);

  // R: the number is already on 새온정밀's certificate; the field says where and offers both ways out.
  await admin.getByLabel("사업자등록번호").fill(REGISTRATION_FIXTURES.primary.brn);
  await expect(admin.getByText(/이 번호는 이미 주식회사 새온정밀/)).toBeVisible();
  await expect(admin.getByRole("link", { name: "그 등록증 열기" })).toBeVisible();
  // R: a future 개업연월일. The foot counts and names both, and nothing can go on.
  await fillDate(admin, "2099-01-01", "개업연월일");
  await expect(foot).toHaveText(/수정할 칸 2개 · 등록번호, 개업연월일/);
  await expect(admin.getByRole("button", { name: "다음: 등기·대표자" })).toHaveAttribute("aria-disabled", "true");
  await expect(admin.getByRole("button", { name: "여기까지 저장" })).toHaveAttribute("aria-disabled", "true");
  await expect(admin.getByRole("region", { name: "등록증 항목" }).getByText("수정할 항목")).toHaveCount(2);
  await expectAccessible(admin, "S4 wizard: validation errors");

  await c.click(admin.getByRole("button", { name: "번호 다시 보기" }));
  await admin.getByLabel("사업자등록번호").fill(REGISTRATION_FIXTURES.second.brn);
  await fillDate(admin, "2024-09-01", "개업연월일");
  await expect(foot).toBeHidden();
  // W: a CRN whose check digit does not match only warns, and saving stays possible.
  await admin.getByRole("textbox", { name: /^법인등록번호/ }).fill(CRN_BAD_CHECK);
  await expect(admin.getByText(/끝자리 검증 숫자가 맞지 않습니다/)).toBeVisible();
  await expect(admin.getByRole("region", { name: "등록증 항목" }).getByText("대조 필요")).toBeVisible();
  await admin.getByRole("textbox", { name: /^대표자/ }).fill("윤가온");
  await admin.getByRole("button", { name: "주소를 직접 입력" }).first().click();
  const place = admin.getByRole("group", { name: "사업장 소재지", exact: true });
  await place.getByLabel("도로명주소").fill("충청북도 청주시 흥덕구 오송읍 오송생명로 21");
  await place.getByLabel("우편번호 (5자리)").fill("28160");
  await place.getByRole("button", { name: "이 주소로 저장" }).click();
  await c.click(admin.getByLabel("본점 소재지가 사업장 소재지와 같음"));
  await admin.getByRole("textbox", { name: /^업태/ }).first().fill("제조업");
  await admin.getByRole("textbox", { name: /^종목/ }).first().fill("의약품 원료");
  await c.click(option(admin, "과세유형", "일반과세자"));
  await admin.getByLabel("관할 세무서").fill("청주세무서장");
  // ⑩ left empty: a to-do, never a default; the foot says the certificate waits for it.
  await expect(admin.getByText(/^등록증을 함께 기록하려면 입력하십시오 ·/)).toBeVisible();
  await expectAccessible(admin, "S4 wizard: certificate");

  await c.click(admin.getByRole("button", { name: "다음: 등기·대표자" }));
  await admin.getByLabel("회사성립연월일").fill("2024-08-20");
  await c.click(admin.getByRole("button", { name: "다음", exact: true }));
  await expect(admin.getByRole("heading", { name: "조직도에 생기는 것" })).toBeVisible();
  await expect(admin.getByText(/끝자리 검증 숫자가 맞지 않음 — 등록증과 대조 필요/)).toBeVisible();
  await expect(admin.getByText(/선택 전에는 등록증이 저장되지 않고/)).toBeVisible();
  await expectAccessible(admin, "S4 wizard: review");
  // 「고치기」 goes back to that step and returns.
  await admin.getByRole("button", { name: "사업자 단위 과세 적용 수정" }).click();
  await c.click(option(admin, "사업자 단위 과세 적용", "부"));
  await expect(admin.getByText(/등록증도 함께 저장됩니다/)).toBeVisible();
  await c.click(admin.getByRole("button", { name: "다음: 등기·대표자" }));
  await c.click(admin.getByRole("button", { name: "다음", exact: true }));
  await c.click(admin.getByRole("button", { name: "법인만 등록" }));
  await expect(admin.getByRole("heading", { name: /\(주\)새온바이오/, level: 1 })).toBeVisible();
  expect(c.done("법인 with every 등록증 item (spec §4: 15)")).toBeLessThanOrEqual(15);
});

test("an individual business never collects the owner's birth date; a 고유번호 단체 takes the shared five", { tag: "@org" }, async ({ browser }) => {
  const admin = await openTenant(browser, "cs-variants", "새온그룹");
  await go(admin, "/org/entities/new");
  await option(admin, "사업자 구분", "개인사업자").click();
  await admin.getByLabel("상호").fill("새온공방");
  await admin.getByRole("button", { name: "다음", exact: true }).click();
  await expect(admin.getByRole("heading", { name: "사업자등록증 (개인사업자용)" })).toBeVisible();
  await expect(admin.getByLabel("생년월일")).toHaveValue("수집하지 않음");
  await expect(admin.getByLabel("생년월일")).toHaveAttribute("readonly", "");
  await expect(admin.getByRole("region", { name: "받지 않는 항목" }).getByText(/공동사업자 주민등록번호 · 개인정보 보호법 제24조의2/)).toBeVisible();
  await expect(admin.getByRole("list", { name: "법인 추가 단계" }).getByRole("listitem")).toHaveCount(3);
  await expectAccessible(admin, "S4 wizard: individual");

  await admin.getByRole("button", { name: "사업자 구분 변경" }).click();
  await option(admin, "사업자 구분", "고유번호 단체").click();
  await admin.getByLabel("명칭").fill("새온장학회");
  await admin.getByRole("button", { name: "다음", exact: true }).click();
  await expect(admin.getByText(/아래 다섯 가지만 받고 원본을 보관합니다/)).toBeVisible();
  await expectAccessible(admin, "S4 wizard: 고유번호 단체");
  await admin.getByRole("textbox", { name: /^대표자/ }).fill("박새온");
  await admin.getByRole("button", { name: "다음", exact: true }).click();
  await admin.getByRole("button", { name: "법인만 등록" }).click();
  await expect(admin.getByRole("heading", { name: /새온장학회/, level: 1 })).toBeVisible();
});
