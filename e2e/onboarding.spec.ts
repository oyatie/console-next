import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, passkeyLogin, routeReady, stepUp } from "./flows";
import { tenantWithExecutive } from "./setup-flows";

// The production path from an empty database: vendor cold start → tenant → admin → executive → setup → operating.
test("onboarding creates every account through the product", { tag: "@smoke" }, async ({ browser }) => {
  const { admin, exec } = await tenantWithExecutive(browser, "hanbit", "한빛정밀", true);
  // The executive signed in while the tenant was still in setup.
  await exec.reload();
  await expect(exec.getByRole("heading", { name: "이임원님" })).toBeVisible();
  // The menu follows the caller's /me/authz grants (executives read org changes and the directory).
  const menu = exec.getByRole("navigation", { name: "주 메뉴" });
  await expect(menu.getByRole("link", { name: "조직 구조" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "인사" })).toBeVisible();
  // The tenant operates (its setup was finished by the admin): neither the setup list nor a getting-started card shows.
  await expect(exec.getByRole("region", { name: /운영 준비|^시작$/ })).toHaveCount(0);
  await expectAccessible(exec, "home");
  // A direct link to registration says the executive lacks access, instead of a form the server refuses.
  await go(exec, "/people/new");
  await expect(exec.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeInViewport();
  await expect(exec.getByRole("heading", { name: "접근 권한이 없습니다" })).toBeVisible();
  await expect(exec.getByLabel("이름", { exact: true })).toHaveCount(0);
  await go(exec, "/");
  // The shell's theme toggle is the real switch; axe re-checks the screen in the chosen theme.
  await exec.getByRole("button", { name: "어두운 화면으로 전환" }).click();
  await expect(exec.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectAccessible(exec, "home (dark via toggle)");
  await exec.getByRole("button", { name: "밝은 화면으로 전환" }).click();
  await expect(exec.locator("html")).toHaveAttribute("data-theme", "light");

  await go(admin, "/people");
  await expect(admin.getByText("아직 직원이 없습니다")).toBeVisible();
  await expectAccessible(admin, "people list (empty)");
  // A reload drops the in-memory access token; the refresh cookie restores the session.
  await admin.reload();
  await expect(admin.getByText("아직 직원이 없습니다")).toBeVisible();

  // Passkey sign-in after sign-out (usernameless, discoverable credential).
  await admin.getByRole("button", { name: "로그아웃" }).click();
  await passkeyLogin(admin);

  // Account administration (governance-01): no role chips and no role change; the panel says what the account may
  // do through its grants; deactivated accounts sit behind a toggle.
  await go(admin, "/people?view=accounts");
  await expect(admin.getByText("계정 2개")).toBeVisible();
  await expect(admin.getByRole("group", { name: "역할" })).toHaveCount(0);
  await expectAccessible(admin, "accounts list");
  await admin.getByRole("row", { name: /이임원/ }).click();
  await routeReady(admin);
  const panel = admin.getByRole("complementary", { name: "이임원" });
  await expect(panel.getByRole("button", { name: "역할 변경" })).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "이 사람이 할 수 있는 일" })).toBeVisible();

  await panel.getByRole("button", { name: "계정 비활성화" }).click();
  const off = admin.getByRole("dialog", { name: "계정 비활성화" });
  await expect(off).toContainText("로그인할 수 없습니다");
  // Deactivating asks for the admin's own passkey first (step-up).
  await stepUp(off, "패스키로 확인하고 계정 비활성화", panel.getByRole("button", { name: "계정 활성화" }));
  await expect(admin.getByRole("row", { name: /이임원/ })).toHaveCount(0);
  await admin.getByRole("button", { name: "비활성 계정 포함" }).click();
  await expect(admin.getByRole("row", { name: /이임원/ })).toContainText("비활성화됨");
  await panel.getByRole("button", { name: "계정 활성화" }).click();
  await expect(admin.getByRole("row", { name: /이임원/ })).not.toContainText("비활성화됨");
});
