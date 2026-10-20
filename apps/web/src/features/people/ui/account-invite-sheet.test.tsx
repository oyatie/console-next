// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { composerBrowser } from "../../../test/composer-browser";

const browser = composerBrowser();
test("invite primary blocks nobody, whitespace name and invalid login, then enables a valid invite", async () => {
  await browser.mount({ sheet: "invite" });
  const page = browser.page;
  const commit = page.getByRole("button", { name: "패스키로 확인하고 계정 초대", exact: true });
  await browser.blocked(commit, "초대할 직원을 선택하십시오");
  expect(await page.getByText("누구를 초대할지 선택하면 생성할 계정을 여기에 보여 드립니다.", { exact: true }).isVisible()).toBe(true);
  await page.getByRole("button", { name: "직원이 아닌 사람 초대", exact: true }).click();
  await page.getByRole("textbox", { name: /이름/ }).fill(" \u3000\t");
  await browser.blocked(commit, "이름을 입력하십시오");
  await page.getByRole("textbox", { name: /이름/ }).fill("가상사용자");
  const login = page.getByRole("textbox", { name: /아이디/ });
  await login.fill("홍길동");
  await browser.blocked(commit);
  await login.fill("a".repeat(32));
  expect(await commit.getAttribute("aria-disabled")).toBeNull();
  const created = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/users");
  await commit.click();
  await created;
  expect(browser.writes).toEqual(["POST /api/v1/users"]);
});
