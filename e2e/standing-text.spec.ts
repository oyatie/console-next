import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, option } from "./flows";
import { openTenant } from "./helpers/tenant";

test("empty screens offer one working entry and forms retain format hints and refusals", { tag: ["@regression", "@org", "@hr"] }, async ({ browser }) => {
  const admin = await openTenant(browser, "standing-copy", "명확한 화면");
  await go(admin, "/people");
  const main = admin.getByRole("main");
  await expect(main.getByRole("heading", { name: "아직 직원이 없습니다" })).toBeVisible();
  await expect(main.getByRole("link", { name: /^직원 등록/ })).toHaveCount(1);
  await expect(main.getByRole("link", { name: "가져오기", exact: true })).toHaveCount(1);
  await expect(main.getByRole("button", { name: "보기 저장" })).toHaveCount(0);
  await expect(main).not.toContainText("여기에 넣은 사람이 사업장별 근로자 명부");
  await expect(main).not.toContainText("엑셀에서 복사한 표로 새 사람을 등록하는 기능");
  await expect(main).not.toContainText("인사카드에서 돌아오면 보던 줄과 위치로 돌아옵니다");
  await expectAccessible(admin, "standing text: empty roster");

  await go(admin, "/access/roles");
  await expect(main.getByRole("link", { name: "역할 추가", exact: true })).toHaveCount(1);
  await expect(main).not.toContainText("역할은 권한 묶음입니다");
  await main.getByRole("link", { name: "역할 추가", exact: true }).focus();
  await admin.keyboard.press("Enter");
  await main.getByRole("button", { name: "역할 추가", exact: true }).click();
  await expect(main.getByText("역할 이름을 입력하십시오.")).toBeVisible();
  await expect(main.getByText("할 수 있는 일을 하나 이상 선택하십시오.")).toBeVisible();
  await expect(main).not.toContainText("범위는 사람에게 부여할 때 정합니다");
  await expectAccessible(admin, "standing text: role validation");

  await go(admin, "/org/entities/new");
  await option(admin, "사업자 구분", "법인사업자").click();
  await admin.getByLabel("법인명(단체명)").fill("주식회사 명확");
  await expect(admin.getByLabel("약칭")).toBeVisible();
  await admin.getByRole("button", { name: "다음", exact: true }).click();
  const number = admin.getByLabel("사업자등록번호", { exact: false });
  await expect(number).toHaveAccessibleDescription("숫자 10자리");
  await expect(main.getByText("진위 미확인", { exact: true })).toBeVisible();
  await number.fill("123");
  await expect(number).toHaveAttribute("aria-invalid", "true");
  await expect(admin.getByRole("button", { name: "여기까지 저장" })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "standing text: format and refusal");
});
