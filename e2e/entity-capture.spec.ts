import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { tenantSlugField, firstSignIn, go, koDate, kstDate, option, takeCode, unique, vendorPage } from "./flows";
import { registerEntity } from "./setup-flows";

// 사업자등록증 capture (gate U2, U3) with bundled reference lists and no outside lookup (decision #16): the 행정구역 list
// is loaded and gives a hand-typed address its codes; lists without a verified or licensed source say so and never
// block; the derived 상시근로자수 shows held; an uploaded certificate is kept and opened as evidence.

async function admin(browser: Browser, name: string, slug: string): Promise<Page> {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill(name);
  await tenantSlugField(v).fill(unique(slug));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  return firstSignIn(browser, await takeCode(v));
}

// UX-R1 ENTITY company-15: a list the product does not bundle is never promised ("not loaded yet"); the printed code is
// typed instead, said to be unchecked, and never blocks.
const notLoaded = async (page: Page, field: string) => {
  const box = page.getByRole("textbox", { name: new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  await expect(box).toBeVisible();
  await expect(box).toHaveAccessibleDescription(/코드 목록을 제공하지 않아 적힌 코드를 그대로 입력합니다/);
  await expect(page.getByText(/목록을 아직 불러오지 않았습니다|목록이 준비되면/)).toHaveCount(0);
};

test("capture: unchecked field labels containing regex characters match literally", async ({ page }) => {
  const field = "코드 [문서] \\ (안내)";
  await page.setContent('<input aria-label="코드 [문서] \\ (안내)" aria-describedby="hint"><p id="hint">코드 목록을 제공하지 않아 적힌 코드를 그대로 입력합니다</p>');
  await notLoaded(page, field);
});

test("capture: the district comes from the bundled list, other lists say they are not loaded and never block", { tag: "@org" }, async ({ browser }) => {
  const a = await admin(browser, "캡처솔루션", "capture");
  await go(a, "/org/entities/new");
  await option(a, "사업자 구분", "법인사업자").click();
  await a.getByLabel("법인명(단체명)").fill("주식회사 캡처솔루션");
  await a.getByRole("button", { name: "다음", exact: true }).click();

  // An address typed by hand (the search is unavailable on this server) takes its district from the bundled list.
  const place = a.getByRole("group", { name: "사업장 소재지", exact: true });
  await a.getByRole("button", { name: "주소를 직접 입력" }).first().click();
  await place.getByLabel("도로명주소").fill("서울특별시 강남구 테헤란로 152");
  await place.getByLabel("우편번호 (5자리)").fill("06236");
  await place.getByRole("button", { name: "이 주소로 저장" }).click();
  const district = a.getByRole("combobox", { name: "행정구역" });
  await district.fill("강남");
  await a.getByRole("option", { name: /강남구/ }).first().click();
  await expect(district).toHaveValue(/강남구/);

  // The main industry is a KSIC pick on the wizard's 등기·대표자 step.
  await a.getByRole("button", { name: "다음: 등기·대표자" }).click();
  await notLoaded(a, "주된 업종 (표준산업분류)");
  await expectAccessible(a, "entity wizard (district picked, KSIC not loaded)");

  // The same entity registers by hand with nothing coded; its 상시근로자수 is derived, held for a labor attorney.
  // Wait for the list to render: its consent guard may still be loading while the URL already changed.
  await go(a, "/org/entities");
  await expect(a.getByRole("heading", { name: "법인·사업장", exact: true })).toBeVisible();
  await go(a, "/org/entities/new");
  await expect(a.getByLabel("법인명(단체명)")).toHaveValue("");
  await registerEntity(a, "캡처솔루션");
  const headcount = a.getByRole("group", { name: "상시근로자수" });
  await expect(headcount).toContainText("산정 보류");
  await expect(headcount).toContainText("노무사 확인 전");
  await expect(headcount).toContainText(`${koDate(kstDate())} 재직 0명`);

  // Its workplace asks the NHIS branch office from its list, which has no verified source yet.
  await a.getByRole("link", { name: "사업장 추가" }).first().click();
  await option(a, "4대보험", "보험별로 다름").click();
  await a.getByRole("group", { name: "건강보험", exact: true }).getByRole("radiogroup", { name: /상태/ }).getByText("성립", { exact: true }).click();
  await notLoaded(a, "관할 건강보험 지사");
  await expectAccessible(a, "new workplace (NHIS branch list not loaded)");
});

// A minimal one-page PDF: the server keeps PDF, JPEG or PNG originals.
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

test("a certificate upload is typed beside, kept as the registration's evidence and opened from the documents tab", { tag: "@org" }, async ({ browser }) => {
  const a = await admin(browser, "증빙솔루션", "capture-doc");
  await go(a, "/org/entities/new");
  await registerEntity(a, "증빙솔루션", true, undefined, undefined, { name: "사업자등록증.pdf", mimeType: "application/pdf", buffer: PDF });
  await a.getByRole("button", { name: /^문서 1/ }).click();
  const row = a.getByRole("row", { name: /사업자등록증\.pdf/ });
  await expect(row).toContainText("사용 중");
  const saved = a.waitForEvent("download");
  await row.getByRole("button", { name: "사업자등록증.pdf 원본 열기" }).click();
  expect((await saved).suggestedFilename()).toBe("사업자등록증.pdf");
  await expectAccessible(a, "entity documents");
});
