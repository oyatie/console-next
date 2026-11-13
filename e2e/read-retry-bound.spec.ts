// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { soloTenant } from "./chaos";

// RETRY rows and route inventory in units/live-maturity-gap-89cf5ee.md. Each navigation gets a fresh QueryClient;
// an in-app navigation alone could hide the defect behind a successful cached checklist.
const routes = ["/", "/people/bulk", "/people/renew", "/org/changes", "/org/history", "/org/move", "/org/import", "/org/paste", "/org/workplaces/edit", "/org/changes/01900000-0000-7000-8000-000000000001"];
const reference = "read-outage";

for (const [index, path] of routes.entries()) {
  test(`failed reads stay bounded for 15 s on ${path}`, { tag: ["@regression", "@negative"] }, async ({ browser }) => {
    const page = await soloTenant(browser, `retry-bound-${index}`, "읽기복구그룹");
    const counts = new Map<string, number>();
    const references = new Map<string, string>();
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      // Keep the authenticated principal and capabilities real, so screen-specific reads are exercised.
      if (!url.pathname.startsWith("/api/") || request.method() !== "GET" || url.pathname.startsWith("/api/v1/auth/") || ["/api/v1/users/me", "/api/v1/me/authz", "/api/v1/events"].includes(url.pathname)) return route.fallback();
      url.searchParams.sort();
      const key = url.pathname + url.search;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!references.has(key)) references.set(key, `${reference}-${references.size}`);
      await route.fulfill({ status: 503, contentType: "application/json", headers: { "operation-id": references.get(key)! }, body: JSON.stringify({ error: { code: "service_unavailable", message: "일시적으로 불러올 수 없습니다." } }) });
    });
    await page.goto(path);
    await page.waitForTimeout(15_000);
    expect(counts.size, "the failure fixture exercised data reads").toBeGreaterThan(0);
    for (const [key, count] of counts) expect(count, `${path}: ${key}`).toBeLessThanOrEqual(3);
    const failed = (path === "/" ? page.getByRole("region", { name: "업무함", exact: true }) : page.getByRole("main")).getByRole("alert").filter({ hasText: reference }).first();
    await expect(failed).toContainText(reference);
    await expect(failed).toContainText("불러오지 못했습니다");
    await expect(failed.getByRole("button", { name: "다시 불러오기", exact: true })).toBeVisible();
    // 87ccb7560a retired the phase-band error; retry belongs to the read named by this alert.
    const operationId = await failed.locator("[data-support-reference]").getAttribute("data-support-reference");
    const key = [...references].find(([, id]) => id === operationId)?.[0];
    expect(key, "the displayed reference identifies the failed read").toBeDefined();
    counts.clear();
    await failed.getByRole("button", { name: "다시 불러오기", exact: true }).click();
    await expect.poll(() => counts.get(key!) ?? 0, `retry ${key}`).toBe(1);
    await page.context().close();
  });
}
