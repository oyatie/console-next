// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { AT, id, user } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

// Run against Vite and the built SPA: production's preload errors must also preserve the form.
for (const asset of ["js", "css"] as const) {
  test(`a missing calendar ${asset} keeps the registration draft and typed date entry`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[1], "empty");
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
    const documents: string[] = [], errors: string[] = [];
    page.on("request", request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url()); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route(url => /\/(date-calendar[-.])/.test(url.pathname) && (asset === "css" ? url.pathname.endsWith(".css") : /\.(js|tsx)$/.test(url.pathname)), route => route.fulfill({ status: 404, body: "" }));
    try {
      await page.goto("/people/new");
      const name = page.getByRole("textbox", { name: /^이름/ });
      const birth = page.getByRole("textbox", { name: /^생년월일/ });
      const trigger = page.getByRole("button", { name: t("uiDate.calendar.open"), exact: true }).first();
      await name.fill("김보존");
      await birth.fill("19900101");
      await trigger.focus();
      await trigger.press("Enter");
      const calendar = page.getByRole("dialog", { name: t("uiDate.calendar.label"), exact: true });
      await expect(calendar.getByRole("alert")).toContainText("날짜를 직접 입력");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(name).toHaveValue("김보존");
      await expect(birth).toHaveValue("1990. 01. 01.");
      await birth.fill("19900203");
      await birth.press("Tab");
      await expect(birth).toHaveValue("1990. 02. 03.");
      expect(documents).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      fixture.release();
      await page.close();
    }
  });
}

test("a failed route still renders the crash screen with recovery", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "empty");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
  await page.route(url => /\/people-route(-[^/]*)?\.(js|tsx)$/.test(url.pathname), route => route.fulfill({
    contentType: "text/javascript", body: 'export function PeopleRoute() { throw new Error("screen render failed"); }',
  }));
  try {
    await page.goto("/people");
    await expect(page.getByRole("heading", { name: "화면을 표시하지 못했습니다", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "페이지 새로 고침", exact: true })).toBeVisible();
  } finally {
    fixture.release();
    await page.close();
  }
});

for (const failure of ["missing chunk", "render error"] as const) {
  test(`a route ${failure} recovers when the crash chunk is also unavailable`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[1], "empty");
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
    const reference = id(99);
    await page.route(url => url.pathname === "/api/v1/client-errors", route => route.fulfill({ status: 200, json: { support_ref: reference, support_ref_at: AT } }));
    const documents: string[] = [];
    let failedRoutes = 0;
    page.on("request", request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url()); });
    // Dev serves static imports separately; only fail a crash-screen fetch made after the route failed.
    await page.route(url => /\/(crash-screen[-.])/.test(url.pathname), route => failedRoutes ? route.fulfill({ status: 404, body: "" }) : route.fallback());
    await page.route(url => /\/people-route(-[^/]*)?\.(js|tsx)$/.test(url.pathname), route => {
      failedRoutes++;
      return route.fulfill(failure === "missing chunk" ? { status: 404, body: "" } : {
        contentType: "text/javascript", body: 'export function PeopleRoute() { throw new Error("screen render failed"); }',
      });
    });
    try {
      await page.goto("/people");
      await expect(page.getByRole("heading", { name: t("common.crashed.title"), exact: true })).toHaveCount(1);
      await expect(page.getByRole("heading", { name: t("common.crashed.title"), exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: t("common.crashed.action"), exact: true })).toBeVisible();
      await expect(page.locator(`[data-support-reference="${reference}"]`)).toBeVisible();
      expect(failedRoutes).toBeGreaterThan(0);
      expect(documents.length).toBeLessThanOrEqual(2);
      expect(documents).toHaveLength(failure === "missing chunk" ? 2 : 1);
    } finally {
      fixture.release();
      await page.close();
    }
  });
}
