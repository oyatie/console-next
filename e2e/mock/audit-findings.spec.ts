// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { installFaultClock } from "../states/fault-clock";
import { screens } from "../states/registry";
import { AT, authz, failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

type S = components["schemas"];
const path = "/api/v1/integrity/findings";
const view = "served_integrity_findings";
const edit = "served_integrity_triage";
const sample: S["GovernanceFinding"] = {
  id: id(42), org_id: id(4), detector_id: "anomaly.price_outlier", entity_type: "purchase_request", entity_id: "PUR-17",
  score: 1.5, severity: "HIGH", evidence: { observed: 25000 }, status: "OPEN", detected_at: AT, created_at: AT, updated_at: AT,
};
async function setup(page: Page, caps: string[]) {
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
  const screen = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/authz", {
    status: 200, json: {
      ...authz,
      capabilities: caps.map((feature): S["MeAuthzCapability"] => ({ feature, permission: "allow", branch_scope: { kind: "all" }, org_wide: false, scoped: false }))
    }
  });
  return screen;
}
for (const width of [1440, 390]) test(`review a detector finding and record one decision at ${width}px`, async ({ page }) => {
  const screen = await setup(page, [view, edit]);
  await page.setViewportSize({ width, height: 900 });
  let row = sample;
  let calls = 0;
  await mockRoute(page, "get", path, () => ({ status: 200, json: [row] }));
  await mockRoute(page, "post", "/api/v1/integrity/findings/{id}/triage", req => {
    expect(req.url()).toContain(sample.id);
    expect(req.headers()["idempotency-key"]).toBeTruthy();
    const body = req.postDataJSON();
    expect(body).toEqual({ status: "ESCALATED", memo: "Check supplier invoice" });
    calls++;
    row = { ...row, status: "ESCALATED", review_memo: body.memo, reviewed_at: AT };
    return { status: 200, json: row };
  });
  await page.goto("/audit/findings");
  const action = page.getByRole("button", { name: "Review finding", exact: true });
  if (width === 390) {
    await expect(action).toHaveCount(0);
    const first = page.getByRole("rowheader", { name: "Unusual purchase price" });
    await first.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByText("PUR-17")).toBeVisible();
  await fits(page, "integrity register");
  await expectAxe(page, "integrity register");
  await action.click();
  await page.getByRole("combobox", { name: "Review outcome" }).selectOption("ESCALATED");
  const save = page.locator("[data-composer-root]").getByRole("button", { name: /record/i });
  await save.click();
  expect(calls).toBe(0);
  await page.getByLabel("Review note").fill("Check supplier invoice");
  await save.click();
  await expect(page.getByText("Check supplier invoice", { exact: true })).toBeVisible();
  await expect(action).toHaveCount(0);
  expect(calls).toBe(1);
  expect(screen.unexpected).toEqual([]);
});
test("a reader can inspect a finding without a triage grant", async ({ page }) => {
  const screen = await setup(page, [view]);
  await mockRoute(page, "get", path, { status: 200, json: [sample] });
  await page.goto("/audit/findings");
  await expect(page.getByText("PUR-17")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review finding" })).toHaveCount(0);
  expect(screen.unexpected).toEqual([]);
});
test("unserved integrity refuses a direct visit before findings are read", async ({ page }) => {
  const screen = await setup(page, ["integrity_findings_read"]);
  await page.goto("/audit/findings");
  await expect(page.getByRole("main")).toContainText(/access|permission/i);
  await expect(page.getByRole("grid")).toHaveCount(0);
  expect(screen.unexpected).toEqual([]);
});
test("retry a failed findings read into a confirmed empty register", async ({ page }) => {
  const screen = await setup(page, [view]);
  await installFaultClock(page, req => new URL(req.url()).pathname === path);
  let ready = false;
  await mockRoute(page, "get", path, () => ready ? { status: 200, json: [] } : { status: 503, json: failure("unavailable") });
  await page.goto("/audit/findings");
  const btn = page.getByRole("button", { name: "Reload", exact: true });
  await expect(btn).toBeVisible();
  ready = true;
  await btn.click();
  await expect(page.getByText("No findings to review")).toBeVisible();
  expect(screen.unexpected).toEqual([]);
});

test("a conflict refreshes the decision recorded by the other reviewer", async ({ page }) => {
  const screen = await setup(page, [view, edit]);
  let row = sample;
  await mockRoute(page, "get", path, () => ({ status: 200, json: [row] }));
  await mockRoute(page, "post", "/api/v1/integrity/findings/{id}/triage", () => {
    row = { ...row, status: "REVIEWED", reviewed_at: AT, review_memo: "Reconciled by another reviewer" };
    return { status: 409, json: failure("conflict") };
  });
  await page.goto("/audit/findings");
  const action = page.getByRole("button", { name: "Review finding", exact: true });
  await action.click();
  await page.getByRole("combobox", { name: "Review outcome" }).selectOption("REVIEWED");
  await page.locator("[data-composer-root]").getByRole("button", { name: /record/i }).click();
  await expect(page.getByText("This finding already has a recorded decision.")).toBeVisible();
  await expect(page.getByText("Reconciled by another reviewer")).toBeVisible();
  await expect(action).toHaveCount(0);
  expect(screen.unexpected).toEqual([]);
});
