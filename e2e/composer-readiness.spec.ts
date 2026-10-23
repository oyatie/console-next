// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Locator } from "@playwright/test";
import { go } from "./flows";
import { openTenant } from "./helpers/tenant";

async function blocked(button: Locator, reason: string) {
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).not.toHaveAttribute("disabled");
  await expect(button).toHaveAttribute("type", "button");
  await expect(button).toHaveAccessibleDescription(reason);
  const id = await button.getAttribute("aria-describedby");
  await expect(button.page().locator(`[id="${id}"]`)).toBeVisible();
  await button.click({ force: true });
  await button.focus();
  await button.press("Enter");
  await button.press("Space");
}

test("empty composers explain their blocks, keep focus and reveal access field errors without writes", { tag: "@regression" }, async ({ browser }) => {
  const admin = await openTenant(browser, "composer-ready", "입력준비상사");
  const writes: string[] = [];
  admin.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/v1\/(users|legal-entities|access|change-sets)(\/|$)/.test(new URL(r.url()).pathname)) writes.push(r.url());
  });

  await go(admin, "/people?bulk=paste");
  const bulk = admin.getByRole("dialog", { name: "일괄 발령", exact: true });
  await blocked(bulk.getByRole("button", { name: "0명 발령", exact: true }), "4개 항목을 채워야 합니다");
  await bulk.getByRole("button", { name: "돌아가기" }).click();

  await go(admin, "/people?view=accounts");
  await admin.getByRole("button", { name: "계정 초대", exact: true }).click();
  const invite = admin.getByRole("dialog", { name: "계정 초대", exact: true });
  const invitePrimary = invite.getByRole("button", { name: "패스키로 확인하고 계정 초대" });
  await blocked(invitePrimary, "초대할 직원을 선택하십시오");
  await invite.getByRole("button", { name: "직원이 아닌 사람 초대" }).click();
  await invite.getByRole("textbox", { name: /^이름/ }).fill("홍길동");
  await invite.getByRole("textbox", { name: /^아이디/ }).fill("홍길동");
  await blocked(invitePrimary, "한글이나 전각 문자는 쓸 수 없습니다. 한/영 키를 확인하십시오.");
  await invite.getByRole("button", { name: "돌아가기" }).click();

  await go(admin, "/access/grants/bulk");
  const preview = admin.getByRole("button", { name: "0명 미리보기", exact: true });
  await blocked(preview, "부여할 사람을 한 명 이상 선택하십시오.");
  await expect(admin.getByRole("alert").filter({ hasText: "부여할 사람을 한 명 이상 선택하십시오." })).toBeVisible();
  await expect(admin.getByText("사유를 선택하십시오.", { exact: true })).toBeVisible();

  await go(admin, "/org/entities?add=true");
  const entity = admin.getByRole("dialog", { name: "법인 추가", exact: true });
  const reason = "사업자 구분, 이름, 대표자를 정하면 저장할 수 있습니다.";
  await blocked(entity.getByRole("button", { name: "법인 등록", exact: true }), reason);
  await expect(entity.getByText(reason, { exact: true })).toHaveCount(1);
  await expect(entity.getByRole("button", { name: "법인 등록 후 첫 사업장 추가" })).toHaveCount(0);
  expect(writes).toEqual([]);
});
