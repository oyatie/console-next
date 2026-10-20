// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { composerBrowser } from "../../../test/composer-browser";

const browser = composerBrowser();
test("법인 등록 quick sheet keeps a filled inert primary with its own visible reason", async () => {
  await browser.mount({ sheet: "entity" });
  const page = browser.page;
  expect(await page.getByRole("dialog", { name: "법인 추가" }).isVisible()).toBe(true);
  expect(await page.getByText("법인 · 1번째 법인", { exact: true }).isVisible()).toBe(true);
  await browser.blocked(page.getByRole("button", { name: "법인 등록", exact: true }), "사업자 구분, 이름, 대표자를 정하면 저장할 수 있습니다.");
  // The consequence is rendered too; the control's own reason is an additional visible explanation.
  expect(await page.getByText("사업자 구분, 이름, 대표자를 정하면 저장할 수 있습니다.", { exact: true }).count()).toBe(2);
});
