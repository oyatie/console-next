// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { mockRoute } from "./route";
import { routeReady } from "../flows";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { mockScreen } from "./screen";
import { authz } from "./fixtures";
import { moveDetail } from "./lifecycle-sheets";

test.beforeAll(() => loadCatalog("ko"));

test("personnel record preload metadata stays behind its lazy record entry", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const initial = [
    html.match(/<script type="module"[^>]*src="([^"]+)"/)![1]!,
    ...[...html.matchAll(/rel="modulepreload"[^>]*href="([^"]+\.js)"/g)].map(match => match[1]!),
  ];
  for (const file of initial) {
    const source = await (await request.get(file)).text();
    expect(source.match(/assets\/card-page-[^" ]+/g) ?? []).toEqual([]);
  }
});

for (const action of ["multi", "exit.report"]) for (const width of [1440, 390]) test(`personnel ${action} waits for the action chunk at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities, ...["employee_directory_manage", "exit_case_report"].map(feature => ({ feature, permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false }))] } });
  await mockRoute(page, "get", "/api/v1/directory/people", { status: 200, json: { items: [], total: 0, offset: 0, limit: 20 } });
  const held = Promise.withResolvers<void>();
  let requested = 0;
  const rosterChunks: string[] = [];
  page.on("request", request => {
    if (/\/assets\/people-route-[^/]+\.js$/.test(request.url())) rosterChunks.push(request.url());
  });
  await page.route(/\/assets\/person-act-[^/]+\.js$/, async route => {
    requested++;
    await held.promise;
    await route.continue();
  });
  try {
    await page.goto(`/people/${moveDetail.employee.id}`);
    await routeReady(page);
    await expect(page.getByRole("heading", { level: 1, name: moveDetail.employee.name, exact: true })).toBeVisible();
    expect(requested).toBe(0);
    expect(rosterChunks).toEqual([]);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `personnel/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`card-${width}-${theme}.png`), fullPage: true });
    }
    if (action === "multi") await page.getByRole("group", { name: t("empCard.verbs"), exact: true }).getByRole("button", { name: t("empCard.verb.correct"), exact: true }).click();
    else await page.getByRole("button", { name: t("exit.report"), exact: true }).click();
    await expect.poll(() => requested).toBe(1);
    await expect(page).toHaveURL(new RegExp(`act=${action.replace(".", "\\.")}`));
    // The mounted record stays usable while the unopened forms' code arrives.
    await expect(page.getByRole("heading", { level: 1, name: moveDetail.employee.name, exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    held.resolve();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(requested).toBe(1);
    if (action === "multi") {
      await mockRoute(page, "patch", "/api/v1/employees/{id}", { status: 200, json: {
        employee_id: moveDetail.employee.id, updated_at: moveDetail.employee.updated_at, applied: ["name"], review_required: false,
      } });
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("textbox", { name: t("empFix.field.name"), exact: true }).fill("Corrected employee");
      await sheet.getByText(t("empFix.reason.INPUT_ERROR"), { exact: true }).click();
      await sheet.getByRole("button", { name: commitLabel({ kind: "profile", mode: "correct", count: 1 }), exact: true }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: t("empFix.done", { count: 1 }) })).toBeVisible();
    }
    expect(fixture.unexpected).toEqual([]);
  } finally {
    held.resolve();
    await page.close();
    fixture.release();
  }
});

test("the employee and placement reads overlap the record chunk and are shared on mount", async ({ page }) => {
  const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
  const held = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const reads: string[] = [];
  await mockRoute(page, "get", "/api/v1/employees/{id}", request => {
    reads.push(new URL(request.url()).pathname);
    return { status: 200, json: moveDetail };
  });
  await mockRoute(page, "get", "/api/v1/employment-assignments", request => {
    reads.push(new URL(request.url()).pathname);
    expect(new URL(request.url()).searchParams.get("employee_id")).toBe(moveDetail.employee.id);
    return { status: 200, json: { items: [] } };
  });
  await page.route(/\/assets\/card-page-[^/]+\.js$/, async route => {
    requested.resolve();
    await held.promise;
    await route.continue();
  });
  try {
    await page.goto(`/people/${moveDetail.employee.id}`, { waitUntil: "commit" });
    await requested.promise;
    await expect.poll(() => reads.slice().sort(), { message: "the record reads must start before its chunk finishes" }).toEqual([
      `/api/v1/employees/${moveDetail.employee.id}`, "/api/v1/employment-assignments",
    ].sort());
    held.resolve();
    await expect(page.getByRole("heading", { level: 1, name: moveDetail.employee.name, exact: true })).toBeVisible();
    await routeReady(page);
    expect(reads).toHaveLength(2);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    held.resolve();
    await page.close();
    fixture.release();
  }
});
