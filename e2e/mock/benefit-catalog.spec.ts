// SPDX-License-Identifier: LicenseRef-Proprietary
import { test, expect, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { installFaultClock } from "../states/fault-clock";
import { AT, authz, failure, id } from "./fixtures";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";

type S = components["schemas"];
const list = "/api/v1/benefit-catalog/items", detail = "/api/v1/benefit-catalog/items/{benefit_id}";
const branch = id(12), outside = id(13);
const original: S["BenefitCatalogItem"] = {
  id: id(10), benefit_code: "BEN-1", category: "extra", name: "Transit pass", scope: { scope_type: "ORG" },
  coverage_label: "All staff", cost_label: "Monthly", updated_at: AT, lifecycle: { object_type: "benefit_catalog_item", object_id: id(10) },
  tiers: [{ tier_basis: "grade", tier_key: "senior", value_label: "Senior staff", amount_won: 50000, limit_period: "MONTH", criteria: { grade: "senior" }, display_order: 1 }],
  conditions: [{ condition_kind: "TENURE", condition_key: "year", operator: "gte", display_label: "After one year", condition_value: { months: 12 }, display_order: 2 }],
};
async function mount(page: Page, role: "admin" | "branch" | "read" | "none") {
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
  const screen = await mockScreen(page, screens[0], "populated");
  const cap = (feature: string): S["MeAuthzCapability"] => ({ feature, permission: "allow", org_wide: role === "admin", scoped: true,
    branch_scope: role === "branch" ? { kind: "branches", branches: [branch] } : { kind: "all" } });
  const capabilities = role === "none" ? [] : [cap("served_benefit_catalog"), ...(role === "read" ? [] : [cap("served_benefit_catalog_manage")])];
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities } });
  await mockRoute(page, "get", "/api/v1/branches", { status: 200, json: [[branch, "Central"], [outside, "West"]].map(([id, name]) =>
    ({ id: id!, name: name!, region_id: branch, deactivated_at: null, created_at: AT })) });
  return screen;
}
function pageOf(items: S["BenefitCatalogItem"][]) { return { status: 200 as const, json: { items, total: items.length, offset: 0, limit: 25 } }; }
for (const width of [1440, 390]) test(`read scoped benefit terms with the keyboard at ${width}px`, async ({ page }) => {
  const screen = await mount(page, "read");
  await page.setViewportSize({ width, height: 900 });
  await mockRoute(page, "get", list, pageOf([original]));
  await mockRoute(page, "get", detail, { status: 200, json: original });
  await page.goto("/benefits");
  const row = page.getByRole("rowheader", { name: original.name });
  await expect(row).toBeVisible();
  if (width < 500) { await row.focus(); await page.keyboard.press("Enter"); }
  await expect(page.getByText("Senior staff", { exact: true })).toBeVisible();
  await expect(page.getByText('{"months":12}', { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /add benefit|edit benefit|edit tiers/i })).toHaveCount(0);
  await fits(page, "benefit catalog"); await expectAxe(page, "benefit detail");
  expect(screen.unexpected).toEqual([]);
});

test("branch manager creates in an authorized branch and keeps the original item scope", async ({ page }) => {
  const screen = await mount(page, "branch");
  let current = original;
  await mockRoute(page, "get", list, () => pageOf([current]));
  await mockRoute(page, "get", detail, () => ({ status: 200, json: current }));
  await mockRoute(page, "post", list, req => {
    const body: S["BenefitCatalogCreateRequest"] = req.postDataJSON();
    expect(body.scope).toEqual({ scope_type: "BRANCH", branch_id: branch });
    expect(body.estimatedAnnualCostWon).toBe(1200); expect(body.effectiveOn).toBe("2026-04-11"); expect(body.retiresOn).toBe("2027-04-10");
    expect(req.headers()["idempotency-key"]).toBeTruthy();
    current = { ...original, id: id(11), name: body.name, scope: body.scope, effective_on: body.effectiveOn, retires_on: body.retiresOn, tiers: [], conditions: [] };
    return { status: 201, json: current };
  });
  await mockRoute(page, "patch", detail, req => {
    const body = req.postDataJSON();
    expect(body.expectedUpdatedAt).toBe(AT); expect(body).not.toHaveProperty("scope"); expect(body).not.toHaveProperty("estimatedAnnualCostWon");
    current = { ...current, name: body.name, updated_at: "2026-11-01T08:00:00Z" };
    return { status: 200, json: current };
  });
  await page.goto("/benefits");
  await expect(page.getByText(original.benefit_code)).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit benefit", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add benefit", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: "Benefit name" }).fill("Meals");
  await form.getByRole("combobox", { name: "Category" }).selectOption("extra");
  await form.getByRole("combobox", { name: "Applies to" }).selectOption(branch);
  await expect(form.getByRole("option", { name: /West|Entire organization/ })).toHaveCount(0);
  await form.getByRole("textbox", { name: "Coverage" }).fill("Central staff");
  await form.getByRole("textbox", { name: /^Cost\b/ }).fill("Annual");
  await form.getByRole("spinbutton", { name: "Estimated annual cost" }).fill("1200");
  const start = form.getByRole("textbox", { name: /Effective from/ });
  const end = form.getByRole("textbox", { name: /Effective through/ });
  await start.fill("2026-04-11"); await start.press("Tab");
  await end.fill("2026-04-10"); await end.press("Tab");
  await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await end.fill("2027-04-10"); await end.press("Tab");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Edit benefit", exact: true }).click();
  await expect(form.getByRole("combobox", { name: "Applies to" })).toHaveCount(0);
  await form.getByRole("textbox", { name: "Benefit name" }).fill("Lunch");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("rowheader", { name: "Lunch" })).toBeVisible();
  expect(screen.unexpected).toEqual([]);
});

test("replace rules against the opened revision and recover from a concurrent change", async ({ page }) => {
  const screen = await mount(page, "admin");
  let current = structuredClone(original);
  const nextRevision = "2026-11-06T13:00:00Z";
  await mockRoute(page, "get", list, () => pageOf([current]));
  await mockRoute(page, "get", detail, () => ({ status: 200, json: current }));
  await mockRoute(page, "put", "/api/v1/benefit-catalog/items/{benefit_id}/tiers", req => {
    const body: S["BenefitCatalogReplaceTiersRequest"] = req.postDataJSON();
    expect(body.expectedUpdatedAt).toBe(AT); expect(body.tiers).toEqual([{ ...original.tiers[0], value_label: "Experienced staff" }]);
    current = { ...current, tiers: body.tiers, updated_at: nextRevision }; return { status: 200, json: current };
  });
  await page.goto("/benefits");
  const form = page.getByRole("dialog");
  await page.getByRole("button", { name: "Edit tiers" }).click();
  await form.getByRole("textbox", { name: "Display label" }).fill("Experienced staff");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Experienced staff", { exact: true })).toBeVisible();
  let attempts = 0;
  await mockRoute(page, "put", "/api/v1/benefit-catalog/items/{benefit_id}/conditions", req => {
    const body: S["BenefitCatalogReplaceConditionsRequest"] = req.postDataJSON();
    attempts++;
    if (attempts === 1) {
      expect(body.expectedUpdatedAt).toBe(nextRevision); expect(body.conditions).toEqual([]);
      current = { ...current, updated_at: "2026-11-06T14:00:00Z", conditions: [{ ...original.conditions[0]!, display_label: "Reviewed terms" }] };
      return { status: 409, json: failure("conflict") };
    }
    expect(body.expectedUpdatedAt).toBe(current.updated_at); expect(body.conditions).toEqual([]);
    current = { ...current, conditions: [] }; return { status: 200, json: current };
  });
  await page.getByRole("button", { name: "Edit eligibility conditions" }).click();
  await form.getByRole("button", { name: "Remove from list" }).click();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("Another edit was saved");
  await form.getByRole("button", { name: "Review current item" }).click();
  await expect(page.getByText("Reviewed terms", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit eligibility conditions" }).click();
  await form.getByRole("button", { name: "Remove from list" }).click();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("No conditions recorded")).toBeVisible();
  expect(attempts).toBe(2); expect(screen.unexpected).toEqual([]);
});

test("deny a direct visit before reading catalog data", async ({ page }) => {
  const screen = await mount(page, "none");
  await page.goto("/benefits");
  await expect(page.getByRole("main")).toContainText(/permission|access/i);
  await expect(page.getByRole("button", { name: "Add benefit" })).toHaveCount(0);
  expect(screen.unexpected).toEqual([]);
});
test("retry a failed catalog read and show a true empty state", async ({ page }) => {
  const screen = await mount(page, "admin");
  await installFaultClock(page, req => new URL(req.url()).pathname === list);
  let ready = false;
  await mockRoute(page, "get", list, () => ready ? pageOf([]) : { status: 503, json: failure("unavailable") });
  await page.goto("/benefits");
  const reload = page.getByRole("button", { name: "Reload", exact: true });
  await expect(reload).toBeVisible(); ready = true; await reload.click();
  await expect(page.getByText("No benefits recorded", { exact: true })).toBeVisible();
  expect(screen.unexpected).toEqual([]);
});
