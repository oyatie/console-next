// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { failure, modules, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { saeonAdminToken, saeonAdminUser, saeonUniverse } from "./saeon";
import { captureBuiltConsoleShot, enableConsole } from "./saeon-mod5-6";
import {
  filterSaeonStatutoryFilings,
  saeonStatutoryFilings,
  saeonStatutoryWorkplaces,
  saeonWorkerRegisterPage,
} from "./saeon-mod7-8";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

async function setupSaeonStatutory(
  page: Page,
  opts?: { theme?: "light" | "dark"; refuse?: boolean; failState?: { fail: boolean } },
) {
  await enableConsole(page, opts?.theme ?? "light");
  const fixture = await mockScreen(page, screens[2], "populated");
  const access = screenAccess("/statutory");
  const navEntries = ["/org", "/people", "/approvals", "/attendance", "/payroll"].flatMap((p) => screenAccess(p).entries);

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/onboarding/modules", { status: 200, json: modules.ready });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: { ...access, entries: [...access.entries, ...navEntries] },
  });

  await mockRoute(page, "get", "/api/v1/statutory/workplaces", () => {
    if (opts?.refuse) return { status: 403, json: failure("forbidden") };
    if (opts?.failState?.fail) {
      return { status: 503, json: failure("service_unavailable") };
    }
    return { status: 200, json: saeonStatutoryWorkplaces() };
  });

  const filingQueries: URLSearchParams[] = [];
  await mockRoute(page, "get", "/api/v1/statutory/insurance-filings", (req) => {
    const query = new URL(req.url()).searchParams;
    filingQueries.push(query);
    return { status: 200, json: filterSaeonStatutoryFilings(query) };
  });

  await mockRoute(page, "get", "/api/v1/statutory/worker-register", (req) => {
    const query = new URL(req.url()).searchParams;
    const site = query.get("workplace_id") ?? saeonStatutoryWorkplaces()[1]!.id;
    const asOf = query.get("as_of") ?? "2026-11-01";
    return { status: 200, json: saeonWorkerRegisterPage(site, asOf) };
  });

  return { fixture, filingQueries };
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /statutory renders P2 ListRecord filings and worker register cleanly at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture } = await setupSaeonStatutory(page, { theme });
      const workplaces = saeonStatutoryWorkplaces();
      const firstFilingName = saeonStatutoryFilings()[0]!.name;
      try {
        await page.goto("/statutory");
        const root = page.locator('[data-pattern="list-record"]');
        await expect(root).toBeVisible();
        await expect(root.getByRole("heading", { level: 1, name: t("statutory.title"), exact: true })).toBeVisible();
        const grid = root.getByRole("grid", { name: t("statutory.insurance"), exact: true });
        await expect(grid).toBeVisible();
        await expect(grid).toContainText(firstFilingName);
        if (width === 1440) await expect(grid).toContainText(t("statutory.codeHold"));
        await expect(grid.locator("tbody tr[data-tone]")).toHaveCount(0);
        await expect(grid.locator('data[data-tone="over"]')).toHaveCount(1);

        if (width === 390) {
          const heights = await grid.locator("tbody tr[data-id]").evaluateAll((rows) =>
            rows.map((r) => Math.round(r.getBoundingClientRect().height)),
          );
          for (const h of heights) {
            expect(h).toBeGreaterThanOrEqual(48);
            expect(h).toBeLessThanOrEqual(68);
          }
        }

        await fits(page, `statutory ${width} ${theme}`);
        await expectAxe(page, `statutory ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "statutory", theme);

        await page.goto(`/statutory?tab=register&site=${workplaces[1]!.id}&date=2026-11-01`);
        const regGrid = root.getByRole("grid", { name: t("statutory.register"), exact: true });
        await expect(regGrid).toBeVisible();
        await expect(regGrid).toContainText("910412-1●●●●●●");
        if (width === 1440) await expect(regGrid).toContainText(saeonUniverse.statutory.registerRows[0]!.duty);
        await fits(page, `statutory-register ${width} ${theme}`);
        await expectAxe(page, `statutory-register ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "statutory-register", theme);

        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}

test("Console /statutory supports filters, side inspector, HOLD visibility, and local EDI CSV download without raw PII", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, filingQueries } = await setupSaeonStatutory(page);
  const filings = saeonStatutoryFilings();
  const firstFilingName = filings[0]!.name;
  const secondFilingName = filings[1]!.name;
  const heldFilingName = filings[3]!.name;
  try {
    await page.goto("/statutory");
    const root = page.locator('[data-pattern="list-record"]');
    const grid = root.getByRole("grid", { name: t("statutory.insurance"), exact: true });
    await expect(grid).toContainText(firstFilingName);
    await expect(grid).toContainText(heldFilingName);

    await root.getByRole("button", { name: t("statutory.urgentOnly"), exact: true }).click();
    await expect(grid).toContainText(firstFilingName);
    await expect(grid).not.toContainText(heldFilingName);
    await root.getByRole("button", { name: t("statutory.urgentOnly"), exact: true }).click();

    const openFirst = t("statutory.openRow", { name: firstFilingName, insurer: t("statutory.NHIS"), kind: t("statutory.ACQUIRE") });
    await grid.getByRole("row").filter({ hasText: firstFilingName }).getByRole("button", { name: openFirst, exact: true }).click();
    const detail = page.getByRole("complementary", { name: t("statutory.detailTitle") });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(firstFilingName);
    await expect(detail).toContainText(t("statutory.hold"));

    await grid.locator('[role="row"][data-row-id]').nth(0).locator("label").first().click();
    await grid.locator('[role="row"][data-row-id]').nth(1).locator("label").first().click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: t("statutory.ediExport"), exact: true }).click(),
    ]);
    const path = await download.path();
    const content = readFileSync(path!, "utf8");
    expect(content.startsWith("\uFEFF")).toBe(true);
    expect(content).toContain(firstFilingName);
    expect(content).toContain(secondFilingName);
    expect(content).not.toMatch(/rrn|account|bank|\d{6}-\d{7}/i);
    await expect(page.getByRole("status").filter({ hasText: t("statutory.ediReceiptHint", { count: 2 }) })).toBeVisible();

    const insurerSelect = root.getByRole("button", { name: new RegExp(t("statutory.insurerLabel")) });
    await insurerSelect.click();
    await page.getByRole("option", { name: t("statutory.NHIS"), exact: true }).click();
    expect(filingQueries.some((q) => q.get("insurer") === "NHIS")).toBe(true);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("Console /statutory distinguishes 403 refusal from 503 retry recovery", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const refused = await setupSaeonStatutory(page, { refuse: true });
  try {
    await page.goto("/statutory");
    await expect(page.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
    await expect(page.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(0);
    expect(refused.fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    refused.fixture.release();
  }

  const page2 = await page.context().newPage();
  await page2.setViewportSize({ width: 1440, height: 900 });
  const failState = { fail: true };
  const failed = await setupSaeonStatutory(page2, { failState });
  const firstFilingName = saeonStatutoryFilings()[0]!.name;
  try {
    await page2.goto("/statutory");
    const retry = page2.getByRole("button", { name: t("common.retry"), exact: true });
    await expect(retry).toBeVisible({ timeout: 15_000 });
    failState.fail = false;
    await retry.click();
    await expect(page2.getByText(firstFilingName)).toBeVisible();
    expect(failed.fixture.unexpected).toEqual([]);
  } finally {
    await page2.close();
    failed.fixture.release();
  }
});
