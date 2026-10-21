import { expect, test, type Page } from "@playwright/test";
import { newContext } from "./flows";

test.describe("helper context lifetime", () => {
  test.describe.configure({ mode: "serial" });
  let priorPage: Page;

  test("a test owns the contexts it opens", async ({ browser }) => {
    priorPage = await (await newContext(browser)).newPage();
    expect(priorPage.isClosed()).toBe(false);
  });

  test("the next test closes prior contexts and keeps its own contexts", async ({ browser }) => {
    const currentPage = await (await newContext(browser)).newPage();
    expect(priorPage.isClosed()).toBe(true);
    await newContext(browser);
    expect(currentPage.isClosed()).toBe(false);
  });
});
