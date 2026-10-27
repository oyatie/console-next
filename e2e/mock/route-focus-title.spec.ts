// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { screenAccess, user } from "./fixtures";
import { screens } from "../states/registry";

test("route navigation focuses h1 and announces the page title with the current tenant", async ({ page }) => {
  await mockScreen(page, screens[1], "populated");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: {
    ...screenAccess("/people"), entries: [...screenAccess("/people").entries, ...screenAccess("/org").entries],
  } });
  await page.goto("/people");
  const heading = page.getByRole("main").getByRole("heading", { level: 1 });
  await expect(heading).toBeFocused();
  const peopleTitle = `${await heading.innerText()} · ${user.tenant!.name} · Console`;
  await expect(page).toHaveTitle(peopleTitle);
  await expect(page.locator('[role="status"].sr-only')).toHaveText(peopleTitle);
  await page.locator('.rail a[href="/org"]').click();
  await expect(page).toHaveURL(/\/org$/);
  await expect(heading).toBeFocused();
  const orgTitle = `${await heading.innerText()} · ${user.tenant!.name} · Console`;
  await expect(page).toHaveTitle(orgTitle);
  await expect(page.locator('[role="status"].sr-only')).toHaveText(orgTitle);
  await page.goBack();
  await expect(page).toHaveTitle(peopleTitle);
  await expect(heading).toBeFocused();
  // Same-page URL state must leave the user's control in charge of focus.
  const search = page.getByRole("searchbox").first();
  await search.fill("김");
  await expect(search).toHaveValue("김");
  await expect(search).toBeFocused();
  const status = page.getByRole("button", { name: /^재직 / });
  await status.press("Space");
  await expect(page).toHaveURL(/status=ACTIVE/);
  await expect(heading).not.toBeFocused();
});

test("route chrome receives focus while its read is held, and locale changes refresh title without stealing focus", async ({ page }) => {
  await mockScreen(page, screens[1], "loading");
  await page.goto("/people");
  // Page chrome stays available while the required data is held.
  const heading = page.getByRole("main").getByRole("heading", { level: 1 });
  await expect(heading).toBeFocused();
  const locale = page.getByRole("combobox", { name: "언어" });
  await locale.selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page).toHaveTitle(new RegExp(` · ${user.tenant!.name} · Console$`));
  await expect(page.getByRole("combobox", { name: "Language", exact: true })).toBeFocused();
});

test("scope in the title comes from the signed-in identity", async ({ page }) => {
  await mockScreen(page, screens[1], "populated");
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, tenant: { ...user.tenant!, name: "다른 검증 회사" } } });
  await page.goto("/people");
  await expect(page).toHaveTitle(/ · 다른 검증 회사 · Console$/);
});

test("a refused route presents its refusal heading without exposing the screen", async ({ page }) => {
  await mockScreen(page, screens[1], "populated");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/people"), entries: [] } });
  await page.goto("/people");
  const refusal = page.getByRole("main").getByRole("heading", { name: "이 화면에 접근 권한이 없습니다", exact: true });
  await expect(refusal).toBeFocused();
  await expect(page).toHaveTitle(`이 화면에 접근 권한이 없습니다 · ${user.tenant!.name} · Console`);
  await expect(page.getByRole("grid", { name: "직원", exact: true })).toHaveCount(0);
});
