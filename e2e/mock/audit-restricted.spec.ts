// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { accountScreens } from "../states/account";
import { screens } from "../states/registry";
import { AT, failure, id } from "./fixtures";
import { accountReads } from "./account";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

type S = components["schemas"];
const route = "/audit/restricted";
const eligibility = "/api/v1/audit-streams/availability";
const events = "/api/v1/audit-streams/ceo-covert/events";
const history = "/api/v1/audit-streams/ceo-covert/access-events";
const row: S["AuditStreamRecord"] = { id: id(11), actor: id(12), action: "supplier.review", target_type: "review",
  target_id: "April decision", sensitivity: "CEO_COVERT", before_snap: { state: "pending" }, after_snap: { state: "completed" },
  trace_id: id(13), span_id: id(14), occurred_at: AT, created_at: AT };
const response = (kind: S["AuditStreamReadKind"], items: typeof row[], offset = 0, total = items.length): S["AuditStreamPage"] =>
  ({ items, limit: 25, offset, total, stream_key: "ceo_covert_audit", read_kind: kind, access_audit_id: id(100 + offset) });
async function setup(page: Page, permissions: { events: boolean; access_events: boolean }, account = false) {
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
  const screen = await mockScreen(page, account ? accountScreens[0] : screens[0], "populated");
  if (account) await accountReads(page, "save-unchanged");
  await mockRoute(page, "get", eligibility, { status: 200, json: permissions });
  return screen;
}

for (const width of [1440, 390]) test(`one audited read per selected stream or page, with keyboard detail at ${width}px`, async ({ page }) => {
  const screen = await setup(page, { events: true, access_events: true });
  await page.setViewportSize({ width, height: 900 });
  const calls: string[] = [];
  await mockRoute(page, "get", events, req => {
    const params = new URL(req.url()).searchParams;
    expect(params.get("limit")).toBe("25");
    const offset = Number(params.get("offset"));
    calls.push("events " + offset);
    const items = offset ? [{ ...row, target_id: "Earlier decision" }] : [row, ...Array.from({ length: 24 }, (_, n) => ({ ...row, id: id(n + 50), action: "review.archive" }))];
    return { status: 200, json: response("events", items, offset, 26) };
  });
  await mockRoute(page, "get", history, () => {
    calls.push("history"); return { status: 200, json: response("access_events", [{ ...row, action: "audit_stream.ceo_read" }]) };
  });
  await page.goto(route);
  const first = page.getByRole("rowheader", { name: "supplier.review" });
  await expect(first).toBeVisible();
  if (width === 390) { await first.focus(); await page.keyboard.press("Enter"); }
  await expect(page.getByText(/Before: pending.*After: completed/)).toBeVisible();
  await fits(page, "restricted audit record");
  await expectAxe(page, "restricted audit record");
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
  expect(calls).toEqual(["events 0"]);
  if (width === 390) await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Earlier decision", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Access history", exact: true }).click();
  await expect(page.getByRole("rowheader", { name: "Restricted events viewed" })).toBeVisible();
  await expect(page.getByText("Earlier decision", { exact: true })).toHaveCount(0);
  expect(calls).toEqual(["events 0", "events 25", "history"]);
  expect(screen.unexpected).toEqual([]);
});

test("a clearance holder can discover the stream on My access without reading it", async ({ page }) => {
  const screen = await setup(page, { events: false, access_events: true }, true);
  let calls = 0;
  await mockRoute(page, "get", history, () => { ++calls; return { status: 200, json: response("access_events", []) }; });
  await page.goto("/account");
  await page.getByRole("link", { name: "Restricted audit", exact: true }).waitFor();
  expect(calls).toBe(0);
  await page.getByRole("link", { name: "Restricted audit", exact: true }).click();
  await expect(page.getByText("No recorded events")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restricted events" })).toHaveCount(0);
  expect(calls).toBe(1);
  expect(screen.unexpected).toEqual([]);
});

test("clearance refusal hides discovery and makes no stream request on a direct visit", async ({ page }) => {
  const screen = await setup(page, { events: false, access_events: false }, true);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "My access", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Restricted audit" })).toHaveCount(0);
  await page.goto(route);
  await expect(page.getByRole("main")).toContainText("Requires clearance for the restricted audit stream.");
  await expect(page.getByRole("grid")).toHaveCount(0);
  expect(screen.unexpected).toEqual([]);
});

test("an explicit retry changes an unavailable read into a current clearance refusal", async ({ page }) => {
  const screen = await setup(page, { events: true, access_events: false });
  let count = 0;
  await mockRoute(page, "get", events, () => ++count === 1 ? { status: 503, json: failure("unavailable") } : { status: 403, json: failure("forbidden") });
  await page.goto(route);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByRole("main")).toContainText(/access|permission/i);
  await expect(page.getByRole("grid")).toHaveCount(0);
  expect(count).toBe(2);
  expect(screen.unexpected).toEqual([]);
});
