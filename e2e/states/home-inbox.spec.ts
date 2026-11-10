// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { INBOX_FILTERS } from "../../apps/web/src/features/home/domain/inbox-filter";
import { expectAxe, fits } from "../a11y";
import { AT, failure, id, inbox } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) {
  for (const path of ["/", "/inbox", ...INBOX_FILTERS.filter(tab => tab !== "all").map(tab => `/inbox?tab=${tab}`), "/people/requests", "/requests", `/requests/${id(99)}`]) {
    test(`home inbox ${path}: empty or not found at ${width}px @ui-state`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await mockScreen(page, screens[0], "empty");
      if (path.startsWith("/inbox?tab=")) {
        const available_filters = INBOX_FILTERS.filter(tab => tab !== "all");
        await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: {
          ...inbox(0), has_work: true, available_filters,
          counts: Object.fromEntries(available_filters.map(tab => [tab, { total: 0, total_is_exact: true }])),
        } });
      }
      await mockRoute(page, "get", "/api/v1/change-requests", { status: 200, json: { items: [], total: 0, offset: 0, limit: 50 } });
      await mockRoute(page, "get", "/api/v1/requests/{key}", { status: 404, json: failure("request_not_found") });
      try {
        await page.goto(path);
        const main = page.getByRole("main").first();
        if (path === "/requests") {
          await expect(main.getByText(t("requestOutcome.empty"), { exact: true })).toBeVisible();
          await expect(main.getByRole("textbox")).toHaveValue("");
        } else if (path.startsWith("/requests/")) {
          await expect(main.getByRole("heading", { name: t("common.read.notFound.title"), exact: true })).toBeVisible();
          await expect(main).toContainText(t("requestOutcome.notFound"));
          await expect(main.getByRole("link", { name: t("requestOutcome.lookup"), exact: true })).toHaveAttribute("href", "/requests");
        } else if (path.startsWith("/inbox?tab=")) {
          const tab = new URL(path, "https://console.invalid").searchParams.get("tab")!;
          const tabs = main.getByRole("navigation", { name: t("home.lanes"), exact: true });
          await expect(tabs.locator(`[href="/inbox?tab=${tab}"]`)).toHaveAttribute("aria-current", "page");
          await expect(main.getByRole("heading", { name: t("home.inbox.empty.title"), exact: true })).toBeVisible();
          await expect(main.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toHaveCount(0);
          await expect(main.locator("table")).toHaveCount(0);
        } else {
          await expect(main.getByRole("heading", { name: t(path === "/people/requests" ? "requests.none.title" : "home.noWork.title"), exact: true })).toBeVisible();
          await expect(main.locator("table")).toHaveCount(0);
          if (path === "/people/requests") {
            await main.getByRole("button", { name: t("requests.filters.reset"), exact: true }).click();
            await expect(main).toContainText(t("requests.none.mine"));
          }
        }
        for (const theme of ["light", "dark"]) {
          await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
          await fits(page, `${path}/empty/${width}/${theme}`);
          await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
        }
        await expectAxe(page, `${path}/empty/${width}`);
        expect(fixture.unexpected).toEqual([]);
      } finally { await page.close(); fixture.release(); }
    });
  }

  for (const path of ["/", "/inbox"]) test(`home inbox ${path}: unavailable is not no work at ${width}px @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[0], "empty");
    let unavailable = true;
    await mockRoute(page, "get", "/api/v1/me/action-inbox", () => ({ status: 200, json: {
      ...inbox(0), unavailable: unavailable ? [{ source: "support_access", support_reference: id(98) }] : [],
    } }));
    try {
      await page.goto(path);
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: t("home.empty.partial.title"), exact: true })).toBeVisible();
      await expect(main.getByText(t("home.empty.partial.reason"), { exact: true })).toBeVisible();
      await expect(main.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toHaveCount(0);
      await expect(main.getByRole("alert")).toContainText(id(98));
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
        await fits(page, `${path}/partial/${width}/${theme}`);
        await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
      }
      await expectAxe(page, `${path}/partial/${width}`);
      unavailable = false;
      await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
      await expect(main.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
      await expect(main.getByRole("alert")).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  for (const code of ["change_request_closed", "change_request_self_decision", "change_request_not_assignee", "change_request_not_requester"] as const) {
    test(`home inbox refusal ${code} at ${width}px @ui-state`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await mockScreen(page, screens[0], "empty");
      await mockRoute(page, "get", "/api/v1/requests/{key}", { status: 200, json: {
        id: id(99), idempotency_key: "change-request-decision", command: "POST /api/v1/change-requests/{id}/decide",
        state: "REFUSED", created_at: AT, deadline: null, settled_at: AT,
        inputs_masked: {}, result: null, refusal_code: code, masked: false, touched: [],
      } });
      try {
        await page.goto(`/requests/${id(99)}`);
        const alert = page.getByRole("main").first().locator('[data-tone="danger"]');
        await expect(alert).toContainText(t(`common.failed.code.${code}`));
        await expect(alert).not.toContainText(code);
        const requests = alert.getByRole("link", { name: t("requests.title"), exact: true });
        await expect(requests).toHaveAttribute("href", "/people/requests");
        for (const theme of ["light", "dark"]) {
          await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
          await fits(page, `${code}/${width}/${theme}`);
          await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
        }
        await expectAxe(page, `${code}/${width}`);
        await mockRoute(page, "get", "/api/v1/change-requests", { status: 200, json: { items: [], total: 0, offset: 0, limit: 50 } });
        await requests.click();
        await expect(page).toHaveURL(/\/people\/requests$/);
        await expect(page.getByRole("heading", { level: 1, name: t("requests.title"), exact: true })).toBeVisible();
        expect(fixture.unexpected).toEqual([]);
      } finally { await page.close(); fixture.release(); }
    });
  }
}
