// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { installFaultClock } from "../states/fault-clock";
import { screens } from "../states/registry";
import { authz, failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

const endpoint = "/api/v1/evaluation/my-tasks";
const url = "/me/evaluations";
const subject: components["schemas"]["EvaluationTaskItem"] = {
  subject_id: id(70), employee_id: id(71), employee_name: "Min Seo", cycle_id: id(72),
  cycle_name: "Winter review", due_date: "2026-12-15", kind: "SELF", review_status: null,
};
test.beforeAll(() => loadCatalog("ko"));

async function mount(page: Page, allowed: boolean) {
  const screen = await mockScreen(page, screens[0], "empty");
  const cap = { feature: "served_evaluation_tasks", permission: "allow" as const, org_wide: true,
    branch_scope: { kind: "all" as const }, scoped: false };
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: allowed ? [cap] : [] } });
  return screen;
}

for (const width of [390, 1440]) test(`view the assigned review kind for one subject at ${width}px`, async ({ page }) => {
  const screen = await mount(page, true);
  await page.setViewportSize({ width, height: 900 });
  await mockRoute(page, "get", endpoint, { status: 200, json: { items: [
    subject, { ...subject, kind: "MANAGER", review_status: "DRAFT" },
  ] } });
  try {
    await page.goto(url);
    await page.getByRole("row").filter({ hasText: t("me.evaluation.manager") }).click();
    const pane = page.locator("dl").filter({ has: page.getByText(t("me.evaluation.kind"), { exact: true }) });
    await expect(pane).toContainText(t("me.evaluation.manager"));
    await expect(pane).toContainText(t("me.evaluation.draft"));
    await expect(pane).toContainText(subject.cycle_name);
    await fits(page, url);
    await expectAxe(page, url);
    expect(screen.unexpected).toEqual([]);
  } finally { screen.release(); }
});

test("an unserved evaluation register makes no task request", async ({ page }) => {
  const screen = await mount(page, false);
  let reads = 0;
  await mockRoute(page, "get", endpoint, () => { reads++; return { status: 403, json: failure("forbidden") }; });
  try {
    await page.goto(url);
    await expect(page.getByText(t("me.evaluation.permission"), { exact: false }).first()).toBeVisible();
    expect(reads).toBe(0);
    expect(screen.unexpected).toEqual([]);
  } finally { screen.release(); }
});

test("an unavailable task list retries and recovers to an empty register", async ({ page }) => {
  const screen = await mount(page, true);
  await installFaultClock(page, req => new URL(req.url()).pathname === endpoint);
  let failed = true;
  await mockRoute(page, "get", endpoint, () => failed ? { status: 503, json: failure("unavailable") } : { status: 200, json: { items: [] } });
  try {
    await page.goto(url);
    const retry = page.getByRole("button", { name: t("common.retry"), exact: true }).first();
    await expect(retry).toBeVisible();
    await expect(page.getByText(t("me.evaluation.empty"))).toHaveCount(0);
    failed = false;
    await retry.click();
    await expect(page.getByText(t("me.evaluation.empty"))).toBeVisible();
    expect(screen.unexpected).toEqual([]);
  } finally { screen.release(); }
});
