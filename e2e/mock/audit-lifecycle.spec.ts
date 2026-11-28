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
const objectId = id(42);
const path = "/api/v1/lifecycles/{objectType}/{objectId}";
const screenPath = "/audit/lifecycles/document/" + objectId;
const baseline: S["ObjectLifecycle"] = {
  objectType: "document", objectId, currentState: "draft", legalHold: true,
  retentionUntil: "2030-06-30", createdAt: AT, updatedAt: AT, transitions: [], availableTransitions: ["submitted"],
};
async function setup(page: Page, orgWide = true) {
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
  const model = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [{
    feature: "lifecycle_manage", permission: "allow", branch_scope: { kind: "all" }, org_wide: orgWide, scoped: false,
  }] } });
  return model;
}

for (const width of [1440, 390]) test(`review a lifecycle, retain the deadline and submit an available transition at ${width}px`, async ({ page }) => {
  const model = await setup(page);
  await page.setViewportSize({ width, height: 920 });
  let row = baseline;
  await mockRoute(page, "get", path, () => ({ status: 200, json: row }));
  await mockRoute(page, "post", "/api/v1/lifecycles/{objectType}/{objectId}/hold", req => {
    expect(req.postDataJSON()).toEqual({ legalHold: false, retentionUntil: baseline.retentionUntil, expectedUpdatedAt: baseline.updatedAt });
    row = { ...row, legalHold: false };
    return { status: 200, json: row };
  });
  await mockRoute(page, "post", "/api/v1/lifecycles/{objectType}/{objectId}/transition", req => {
    expect(req.postDataJSON()).toEqual({ toState: "submitted", reason: "Filed for approval" });
    row = { ...row, currentState: "submitted", availableTransitions: [], transitions: [
      { fromState: "draft", toState: "submitted", reason: "Filed for approval", occurredAt: AT },
    ] };
    return { status: 200, json: row };
  });
  await page.goto(screenPath);
  await expect(page.getByText("No transitions recorded")).toBeVisible();
  await page.getByRole("button", { name: "Edit hold and retention" }).click();
  await page.getByRole("combobox", { name: "Legal hold" }).selectOption("clear");
  await page.locator("[data-composer-root]").getByRole("button", { name: /change/i }).click();
  await expect(page.getByText("No hold", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change state" }).click();
  const next = page.getByRole("combobox", { name: "Next state" });
  await next.selectOption("submitted");
  await page.getByLabel("Reason for transition").fill("Filed for approval");
  const submit = page.locator("[data-composer-root]").getByRole("button", { name: /change/i });
  await submit.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Filed for approval")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change state" })).toHaveCount(0);
  await fits(page, "lifecycle record");
  await expectAxe(page, "lifecycle record");
  expect(model.unexpected).toEqual([]);
});
test("a branch-scoped reader cannot open a lifecycle record or send a read", async ({ page }) => {
  const model = await setup(page, false);
  await page.goto(screenPath);
  await expect(page.getByRole("main")).toContainText(/access|permission/i);
  await expect(page.getByRole("button", { name: "Edit hold and retention" })).toHaveCount(0);
  expect(model.unexpected).toEqual([]);
});
test("a failed read can retry into a missing record without a phantom hold form", async ({ page }) => {
  const model = await setup(page);
  await installFaultClock(page, req => new URL(req.url()).pathname.includes("/api/v1/lifecycles/"));
  let missing = false;
  await mockRoute(page, "get", path, () => missing ? { status: 404, json: failure("not_found") } : { status: 503, json: failure("unavailable") });
  await page.goto(screenPath);
  const reload = page.getByRole("button", { name: "Reload", exact: true });
  await expect(reload).toBeVisible();
  missing = true;
  await reload.click();
  await expect(page.getByRole("main")).toContainText(/not found|couldn.t find|no longer/i);
  await expect(page.getByRole("button", { name: "Edit hold and retention" })).toHaveCount(0);
  expect(model.unexpected).toEqual([]);
});

test("a typed lifecycle audit event links to the real record", async ({ page }) => {
  const model = await setup(page);
  await mockRoute(page, "get", "/api/audit", { status: 200, json: {
    items: [{ id: id(16), occurred_at: AT, target_type: "object_lifecycle", target_id: "document:" + objectId, action: "lifecycle.hold" }],
    limit: 25, offset: 0,
  } });
  await mockRoute(page, "get", "/api/v1/audit/attestation", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", path, { status: 200, json: baseline });
  await page.goto("/audit");
  const link = page.getByRole("link", { name: "Open lifecycle record" });
  await expect(link).toHaveAttribute("href", screenPath);
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Object lifecycle" })).toBeVisible();
  expect(model.unexpected).toEqual([]);
});

test("a concurrent hold edit requires the reviewer to inspect the newer retention", async ({ page }) => {
  const model = await setup(page);
  let row = baseline;
  let writes = 0;
  await mockRoute(page, "get", path, () => ({ status: 200, json: row }));
  await mockRoute(page, "post", "/api/v1/lifecycles/{objectType}/{objectId}/hold", req => {
    writes += 1;
    if (writes === 1) {
      expect(req.postDataJSON().expectedUpdatedAt).toBe(baseline.updatedAt);
      row = { ...row, retentionUntil: "2034-06-30", updatedAt: "2030-01-01T00:00:00Z" };
      return { status: 409, json: failure("conflict") };
    }
    expect(req.postDataJSON()).toEqual({ legalHold: false, retentionUntil: "2034-06-30", expectedUpdatedAt: row.updatedAt });
    row = { ...row, legalHold: false };
    return { status: 200, json: row };
  });
  await page.goto(screenPath);
  await page.getByRole("button", { name: "Edit hold and retention" }).click();
  const hold = page.getByRole("combobox", { name: "Legal hold" });
  const save = page.locator("[data-composer-root]").getByRole("button", { name: /change/i });
  await hold.selectOption("clear");
  await save.click();
  await page.getByRole("button", { name: "Review the current hold and deadline" }).click();
  await expect(hold).toHaveValue("held");
  await hold.selectOption("clear");
  await save.click();
  await expect(page.getByText("No hold", { exact: true })).toBeVisible();
  expect(writes).toBe(2);
  expect(model.unexpected).toEqual([]);
});
