// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { authz, failure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";

test.beforeAll(() => loadCatalog("ko"));

// With no lanes a member's statuses take the lanes' place. Classic draws them right after the list toolbar; Console
// draws them first in the page head's filters (no board draws the requests list, so that is the render's value). At
// 390 the shared leg holds the behaviour and the invariants only.
for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const access of ["hr", "member", "failed"]) for (const experience of access !== "member" ? [undefined] : width > 390 ? ["baseline", "console"] as const : ["baseline", undefined] as const) {
  const hr = access !== "member";
  test(`request filters stay still while access loads: ${access}, ${width}px ${theme}${experience ? ` in ${experience}` : ""} @ui-state${experience === "baseline" ? " @baseline" : ""}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    if (experience) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [EXPERIENCE_KEY, experience] as const);
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "empty");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/me/authz", async () => {
      await held;
      if (access === "failed") return { status: 403, json: failure("forbidden") };
      return { status: 200, json: { ...authz, capabilities: hr ? [...authz.capabilities, {
        feature: "employee_directory_manage", permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false,
      }] : authz.capabilities } };
    });
    const reads: URLSearchParams[] = [];
    const countReads: URLSearchParams[] = [];
    const results = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/change-requests", async request => {
      const query = new URL(request.url()).searchParams;
      reads.push(query);
      await results.promise;
      return { status: 200, json: { items: [], total: 0, offset: 0, limit: Number(query.get("limit")) } };
    });
    await mockRoute(page, "get", "/api/v1/change-requests/counts", async request => {
      countReads.push(new URL(request.url()).searchParams);
      await results.promise;
      return { status: 200, json: { all: 0, me: 0, role: 0 } };
    });
    try {
      await page.goto("/people/requests");
      const statuses = page.getByRole("group", { name: t("requests.statuses"), exact: true });
      // Classic groups the lanes as toggles, Console draws them as tab links.
      const lanes = (options?: { includeHidden: true }) => page.getByRole("group", { name: t("requests.lanes"), exact: true, ...options })
        .or(page.getByRole("navigation", { name: t("requests.lanes"), exact: true, ...options }));
      await expect(page.getByRole("main").getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
      await expect(statuses).toHaveCount(0);
      await expect(lanes({ includeHidden: true })).toHaveCount(0);
      expect(reads).toHaveLength(0);
      expect(countReads).toHaveLength(0);
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/me/authz");
      release();
      await loaded;
      await expect(statuses).toBeVisible();
      await expect(lanes()).toHaveCount(hr ? 1 : 0);
      await expect.poll(() => reads.length).toBe(1);
      await expect.poll(() => countReads.length).toBe(hr ? 1 : 0);
      const listReads = reads.filter(query => query.get("limit") === "20");
      expect(listReads.map(query => query.get("requester"))).toEqual([hr ? null : "me"]);
      if (!hr) {
        await expect(lanes({ includeHidden: true })).toHaveCount(0);
        if (experience === "baseline") expect(await statuses.evaluate(el => el.previousElementSibling?.classList.contains("toolbar"))).toBe(true);
        else if (experience === "console") expect(await statuses.evaluate(el => el.previousElementSibling === null)).toBe(true);
      }
      await page.evaluate(() => document.fonts.ready);
      const before = await statuses.boundingBox();
      results.resolve();
      await expect(page.getByRole("heading", { name: t("requests.none.title"), exact: true })).toBeVisible();
      // Compare control positions in both engines; Firefox has no layout-shift performance entries.
      expect(await statuses.boundingBox()).toEqual(before);
      await fits(page, "request filters after access loads");
      await expectAxe(page, "request filters after access loads");
      await page.screenshot({ path: info.outputPath("request-filters.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); results.resolve(); await page.close(); fixture.release(); }
  });
}
