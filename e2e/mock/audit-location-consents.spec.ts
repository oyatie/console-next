// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { installFaultClock } from "../states/fault-clock";
import { screens } from "../states/registry";
import { AT, authz, failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

type S = components["schemas"];
const path = "/api/v1/location-consents/ledger";
const route = "/audit/location-consents";
const north = id(61), south = id(62), west = id(63);
const row: S["LocationConsentLedgerEntry"] = {
  id: id(3), consent_id: id(4), user_id: id(5), branch_id: north, actor: id(5),
  action: "consent.grant", from_status: "NO_RECORD", to_status: "GRANTED", occurred_at: AT, created_at: AT,
};
const pageOf = (items: typeof row[], total = items.length, offset = 0) => ({ status: 200 as const, json: { items, limit: 25, offset, total } });
async function mount(page: Page, scope?: "org" | string[]) {
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
  const screen = await mockScreen(page, screens[0], "populated");
  const cap: S["MeAuthzCapability"] = { feature: "served_location_consent_ledger", permission: "allow",
    branch_scope: scope === "org" ? { kind: "all" } : { kind: "branches", branches: scope ?? [] }, org_wide: scope === "org", scoped: false };
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: scope ? [cap] : [] } });
  await mockRoute(page, "get", "/api/v1/branches", { status: 200, json: ([[north, "North"], [south, "South"], [west, "West"]] as const).map(([id, name]) => ({
    id, name, region_id: north, deactivated_at: null, created_at: AT,
  })) });
  return screen;
}

for (const width of [1440, 390]) test(`inspect a consent transition and download its visible page at ${width}px`, async ({ page }) => {
  const narrow = width === 390;
  const screen = await mount(page, narrow ? [north] : "org");
  await page.setViewportSize({ width, height: 900 });
  const reads: string[] = [];
  await mockRoute(page, "get", path, req => {
    const query = new URL(req.url()).searchParams;
    expect(query.get("branch_id")).toBe(narrow ? north : null);
    expect(query.get("limit")).toBe("25");
    reads.push(query.get("offset")!);
    return query.get("offset") === "0" ? pageOf([row, ...Array.from({ length: 24 }, (_, i) => ({ ...row, id: id(100 + i), action: "consent.suspend" as const, from_status: "GRANTED" as const, to_status: "SUSPENDED" as const }))], 26) : pageOf([{ ...row, id: id(9), action: "consent.withdraw", from_status: "GRANTED", to_status: "WITHDRAWN" }], 26, 25);
  });
  const csv = "consent_id,action\n" + row.consent_id + ",consent.withdraw\n";
  await page.route(url => url.pathname === path + ".csv", async req => {
    const query = new URL(req.request().url()).searchParams;
    expect(query.get("branch_id")).toBe(narrow ? north : null);
    expect(query.get("offset")).toBe("25");
    expect(query.get("limit")).toBe("25");
    await req.fulfill({ status: 200, contentType: "text/csv; charset=utf-8", body: csv });
  });
  await page.goto(route);
  const name = page.getByRole("rowheader", { name: "Consent given" });
  await expect(name).toBeVisible();
  if (narrow) {
    await expect(page.getByRole("option", { name: "West" })).toHaveCount(0);
    await name.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByText(row.consent_id, { exact: true })).toBeVisible();
  await fits(page, "consent ledger");
  await expectAxe(page, "consent ledger");
  if (narrow) await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("rowheader", { name: "Consent withdrawn" })).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download this page as CSV" }).click()]);
  expect(file.suggestedFilename()).toBe("location-consent-ledger.csv");
  expect(await readFile((await file.path())!, "utf8")).toBe(csv);
  expect(reads).toEqual(["0", "25"]);
  expect(screen.unexpected).toEqual([]);
});

test("choose a permitted branch before loading or exporting a multi-branch ledger", async ({ page }) => {
  const screen = await mount(page, [north, south]);
  const reads: string[] = [];
  await mockRoute(page, "get", path, req => {
    reads.push(new URL(req.url()).searchParams.get("branch_id")!);
    return pageOf([]);
  });
  await page.goto(route);
  await expect(page.getByRole("combobox", { name: "Branch" })).toBeVisible();
  await expect(page.getByRole("option", { name: "South" })).toBeAttached();
  await expect(page.getByRole("option", { name: "West" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /CSV/ })).toHaveCount(0);
  expect(reads).toEqual([]);
  await page.getByRole("combobox", { name: "Branch" }).selectOption(south);
  await expect(page.getByText("No consent events", { exact: true })).toBeVisible();
  expect(reads).toEqual([south]);
  expect(screen.unexpected).toEqual([]);
});

test("refuse a direct visit before reading the ledger", async ({ page }) => {
  const screen = await mount(page);
  await page.goto(route);
  await expect(page.getByRole("main")).toContainText(/access|permission/i);
  await expect(page.getByRole("button", { name: /CSV/ })).toHaveCount(0);
  expect(screen.unexpected).toEqual([]);
});

test("retry an unavailable ledger and show a refused CSV without discarding the register", async ({ page }) => {
  const screen = await mount(page, [north]);
  await installFaultClock(page, req => new URL(req.url()).pathname === path);
  let ready = false;
  await mockRoute(page, "get", path, () => ready ? pageOf([row]) : { status: 503, json: failure("unavailable") });
  await mockRoute(page, "get", "/api/v1/location-consents/ledger.csv", { status: 403, json: failure("forbidden") });
  await page.goto(route);
  const reload = page.getByRole("button", { name: "Reload", exact: true });
  await expect(reload).toBeVisible();
  ready = true;
  await reload.click();
  await page.getByRole("button", { name: "Download this page as CSV" }).click();
  await expect(page.getByRole("alert")).toContainText(/permission|access/i);
  await expect(page.getByRole("rowheader", { name: "Consent given" })).toBeVisible();
  expect(screen.unexpected).toEqual([]);
});
