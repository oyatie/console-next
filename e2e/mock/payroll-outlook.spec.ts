// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { authz, failure, modules } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

const path = "/api/v1/analytics/projection";
const outlook = "/payroll/outlook";
const report: components["schemas"]["ProjectionResult"] = {
  point_estimate: 101000, ci95_low: 94000, ci95_high: 112000, cvar95: 91700,
  assumptions: { simulations: 1024, seed: 15, drift: 0.01, ewma_volatility: 0.02, student_t_nu: 4 },
};

async function setup(page: Page, served: boolean) {
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
  const mock = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/onboarding/modules", { status: 200, json: [...modules.ready, { key: "payroll", ready: true, unblock: null }] });
  const caps: components["schemas"]["MeAuthzCapability"][] = (served ? ["kpi_read", "analytics_projection"] : ["kpi_read"]).map(feature =>
    ({ feature, permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }));
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: caps } });
  return mock;
}

for (const width of [1440, 390]) test(`a user-entered payroll scenario at ${width}px preserves the inputs and the server's interval`, async ({ page }) => {
  const mock = await setup(page, true);
  await page.setViewportSize({ width, height: 900 });
  const bodies: unknown[] = [];
  let answer!: () => void;
  const waiting = new Promise<void>(resolve => { answer = resolve; });
  await page.route(url => url.pathname === path, async route => {
    bodies.push(route.request().postDataJSON());
    await waiting;
    await route.fulfill({ json: report });
  });
  if (width === 1440) {
    await page.goto("/");
    const entry = page.getByRole("navigation", { name: "Main menu" }).locator('a[href="/payroll/outlook"]');
    await entry.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/payroll\/outlook$/);
  } else {
    await page.goto(outlook);
  }
  await expect(page.getByText("No projection yet")).toBeVisible();
  const amounts = page.getByLabel("Historical payroll totals (KRW)", { exact: false });
  await amounts.fill("90,000\n0\n100000");
  await page.getByRole("button", { name: "Calculate outlook" }).click();
  await expect(page.getByText("Enter at least three positive whole-won totals, one per line.")).toBeVisible();
  expect(bodies).toEqual([]);
  await amounts.fill("90,000\n95000\n100000");
  await page.getByLabel("Periods ahead", { exact: false }).fill("3");
  const calculate = page.getByRole("button", { name: "Calculate outlook" });
  await calculate.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => bodies).toEqual([{ series: [90000, 95000, 100000], horizon: 3, kind: "money" }]);
  await expect(page.getByRole("status", { name: "Loading…" })).toBeVisible();
  answer();
  const region = page.getByRole("region", { name: "Projection results" });
  await expect(region).toContainText("Projection after 3 periods");
  for (const n of ["101,000", "94,000", "112,000", "91,700"]) await expect(region).toContainText(n);
  await region.getByText("Model assumptions").click();
  await expect(region).toContainText("1,024");
  await fits(page, "payroll outlook");
  await expectAxe(page, "payroll outlook");
  await amounts.fill("42");
  await expect(region).toHaveCount(0);
  expect(bodies).toHaveLength(1);
  expect(mock.unexpected).toEqual([]);
});

test("an unserved projection refuses the deep link even when the account has KPI read", async ({ page }) => {
  const mock = await setup(page, false);
  await page.goto(outlook);
  await expect(page.getByRole("main")).toContainText("Requires access to analytics projections.");
  await expect(page.getByRole("button", { name: "Calculate outlook" })).toHaveCount(0);
  expect(mock.unexpected).toEqual([]);
});

test("a failed calculation can be retried and a server refusal withdraws the inputs", async ({ page }) => {
  const mock = await setup(page, true);
  let status = 503;
  await page.route(url => url.pathname === path, route => route.fulfill({ status, json: status === 200 ? report : failure(status === 503 ? "unavailable" : "access_denied") }));
  await page.goto(outlook);
  await page.getByLabel("Historical payroll totals (KRW)", { exact: false }).fill("1000\n1000\n1000");
  await page.getByRole("button", { name: "Calculate outlook" }).click();
  const failed = page.getByRole("alert");
  await expect(failed).toContainText("Couldn’t load");
  status = 200;
  await failed.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByRole("region", { name: "Projection results" })).toBeVisible();
  status = 403;
  await page.getByRole("button", { name: "Calculate outlook" }).click();
  await expect(page.getByRole("main")).toContainText(/access|permission/i);
  await expect(page.getByRole("button", { name: "Calculate outlook" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Projection results" })).toHaveCount(0);
  expect(mock.unexpected).toEqual([]);
});
