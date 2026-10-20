// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { composerBrowser } from "../../../test/composer-browser";

const browser = composerBrowser();
test.each([0, 1])("primary commit blocks %i targets with empty requirements and mixed error rows", async (count) => {
  await browser.mount({ sheet: "bulk", count });
  const page = browser.page;
  const commit = page.getByRole("button", { name: `${count}명 발령`, exact: true });
  await commit.waitFor();
  if (count) await page.getByText("Test Person", { exact: true }).waitFor();
  expect(await page.getByRole("dialog", { name: "일괄 발령" }).isVisible()).toBe(true);
  expect(await page.getByText(`${count}명에게 같은 발령을 기록합니다.`, { exact: true }).isVisible()).toBe(true);
  await browser.blocked(commit, `${count === 0 ? 4 : 3}개 항목을 채워야 합니다`);
  if (count === 0) {
    await browser.mount({ sheet: "bulk", count: 0, paste: true });
    await page.getByRole("textbox", { name: /사번 목록/ }).fill("TEST-1\nMISSING");
    await page.getByText("승진", { exact: true }).click();
    await page.getByRole("textbox", { name: /새 직위/ }).fill("테스트직위");
    await page.locator('input[type="date"]').fill("2099-12-31");
    await page.getByText("기타", { exact: true }).click();
    await page.getByRole("textbox", { name: /사유 \(자유 기재\)/ }).fill("테스트 사유");
    const mixedCommit = page.getByRole("button", { name: /1명 .*승진/ });
    await browser.blocked(mixedCommit, "오류 1줄을 수정하거나 제외해야 기록할 수 있습니다");
    await page.getByRole("button", { name: /MISSING.*제외/ }).click();
    expect(await mixedCommit.getAttribute("aria-disabled")).toBeNull();
    await page.getByRole("textbox", { name: /사번 목록/ }).fill("사번");
    await browser.blocked(page.getByRole("button", { name: /0명 .*승진/ }), "1개 항목을 채워야 합니다");
  }
});
