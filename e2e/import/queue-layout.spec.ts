import { expect, test, type Locator, type Page } from "@playwright/test";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook, payPeriod } from "../helpers/import";
import { plain, workbook } from "../helpers/import-layouts";
import { openItem, panel, queue } from "../helpers/import-queue";

// Regression (EMP-B, parity E7-values / E7-update): with a 확인 필요 item open and the page scrolled down to it, the
// queue grid's header and first row were drawn at the top of the main area, over the 「모의 반영 결과」 card. The grid
// must stay inside its own card wherever the page is scrolled.

const box = async (l: Locator) => (await l.boundingBox())!;

async function expectInsideQueue(page: Page) {
  // The grid holding the open question (a 값 연결 table since E7-values; the queue before) and its own card.
  const grid = queue(page).first();
  // The card that holds the grid: its nearest section (the design system's Card).
  const card = grid.locator("xpath=ancestor::section[1]");
  const result = page.locator('section[aria-labelledby="import-dry"]');
  const header = grid.getByRole("row").first();
  const [c, h, r] = [await box(card), await box(header), await box(result)];
  // The header sits inside the queue's card, below the result card, never above the card's top.
  expect(h.y).toBeGreaterThanOrEqual(c.y);
  expect(h.y + h.height).toBeLessThanOrEqual(c.y + c.height);
  expect(h.y).toBeGreaterThanOrEqual(r.y + r.height);
}

test("import queue: the grid stays inside its card when the page scrolls to the open item", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(180_000);
  const { admin } = await tenantInSetup(browser, "queuelayout", "한결", false, "한결 본점");
  await admin.setViewportSize({ width: 1440, height: 900 });
  await go(admin, "/people/import");
  // 품질팀 is no unit of this company: the dry run asks where it goes.
  const rows = Array.from({ length: 6 }, (_, i) => ({ number: `HJ-01${i}`, name: `사람${i}`, unit: i === 5 ? "품질팀" : "", position: "사원", hired: "2020-01-02" }));
  await chooseWorkbook(admin, "인사기록.xlsx", await workbook([plain("본사", rows)]));
  await payPeriod(admin);
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await expect(queue(admin).first()).toBeVisible({ timeout: 30_000 });
  await openItem(admin, "품질팀");
  await expectInsideQueue(admin);
  // As a person reads on: the open item is brought into view, which scrolls the main area under the grid.
  await panel(admin).scrollIntoViewIfNeeded();
  await admin.locator(".main").evaluate((el) => el.scrollBy(0, 400));
  await expectInsideQueue(admin);
});
