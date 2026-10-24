import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, option, routeReady } from "./flows";
import { openTenant } from "./helpers/tenant";
import { REGISTRATION_FIXTURES, typeAddress } from "./setup-flows";

// LANE ENTITY-FIX: walkthrough W06 on the 법인 wizard and the quick sheet's head (parity S4), from an empty tenant
// through the UI; regression tests that failed on mvp 442d9d7a.

const PDF = { name: "사업자등록증.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") };

/** The document never scrolls: the app's main column is the only scroller, so the shell stays put (W06). */
async function shellHolds(page: Page, screen: string) {
  const m = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    const escaped = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().bottom > innerHeight + 1 && !el.closest(".main"))
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`)
      .slice(0, 5);
    return { over: doc.scrollHeight - innerHeight, scrolled: doc.scrollTop, escaped };
  });
  expect(m, `${screen}: the document scrolls past the app shell`).toEqual({ over: 0, scrolled: 0, escaped: [] });
}

test("the 법인 wizard scrolls inside the shell, never the document (W06)", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "efix-w06", "새온그룹");
  await a.setViewportSize({ width: 1440, height: 900 });
  await go(a, "/org/entities/new");
  await option(a, "사업자 구분", "법인사업자").click();
  await a.getByLabel("법인명(단체명)").fill("주식회사 새온바이오");
  await a.getByRole("button", { name: "다음", exact: true }).click();
  await a.locator('input[type="file"]').setInputFiles(PDF);
  await a.getByLabel("사업자등록번호").fill(REGISTRATION_FIXTURES.primary.brn);
  await a.getByLabel("개업연월일").fill("2024-09-01");
  await typeAddress(a, "사업장 소재지", "충청북도 청주시 흥덕구 오송읍 오송생명로 21", "28160");
  await a.getByRole("textbox", { name: /^업태/ }).first().fill("제조업");
  await a.getByRole("textbox", { name: /^종목/ }).first().fill("의약품 원료");
  await option(a, "발급 사유", "신규").click();
  // Focus far below the fold: the browser brings it into view by scrolling the main column only.
  await a.getByLabel("발급일").focus();
  await a.getByLabel("발급일").fill("2024-09-05");
  await shellHolds(a, "법인 wizard, 발급일 focused");
  await a.getByRole("textbox", { name: /^법인등록번호/ }).focus();
  await shellHolds(a, "법인 wizard, 법인등록번호 focused");
  await expect(a.getByRole("banner").first()).toBeInViewport();
});

test("the quick 법인 sheet says what it needs, and that is what it asks for", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "efix-quick", "새온그룹");
  await go(a, "/org/entities");
  await a.getByRole("link", { name: "법인 추가" }).first().click();
  await routeReady(a);
  const s = a.getByRole("dialog", { name: "법인 추가" });
  // Inputs and the save's refusal name what is needed, without a second explanation above them.
  await expect(s.getByText(/세 가지만|두 가지만/)).toHaveCount(0);
  await expect(s.getByRole("button", { name: "여러 법인 목록 붙여넣기" })).toHaveCount(0);
  await expect(s.getByRole("button", { name: "조직 시트 가져오기" })).toHaveCount(0);
  await expect(s.getByRole("textbox", { name: /^대표자/ })).toBeVisible();
  await option(a, "사업자 구분", "개인사업자").click();
  await s.getByRole("textbox", { name: /^상호/ }).fill("새온공방");
  const create = s.getByRole("button", { name: "법인 등록", exact: true });
  await expect(create).toHaveAttribute("aria-disabled", "true");
  await expect(s.getByText("사업자 구분, 이름, 대표자를 정하면 저장할 수 있습니다.")).toBeVisible();
  await s.getByRole("textbox", { name: /^성명/ }).fill("이새온");
  await expect(create).not.toHaveAttribute("aria-disabled", "true");
  // The corporation's refusal names the additional facts and offers the certificate path.
  await option(a, "사업자 구분", "법인사업자").click();
  await expect(create).toHaveAccessibleDescription(/법인등록번호와 본점 소재지가 있어야/);
  await expect(s.getByRole("button", { name: "등록증 보며 모두 입력" })).toBeEnabled();
  await expect(create).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(a, "S4 quick sheet: corporation");
});
