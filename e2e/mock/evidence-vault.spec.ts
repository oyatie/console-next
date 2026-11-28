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
const object: S["EvidenceObjectView"] = {
  id: id(42), code: "EV-042", title: "Delivery receipt", source: { source_type: "external_document", source_id: "record-42" },
  classification: "Internal", current_custody_stage: "REGISTERED", legal_hold_state: "CLEAR",
  admissibility_status: "REVIEW_NEEDED", admissibility_reasons: [], admissibility_inputs: {},
  created_by: id(1), updated_by: id(1), created_at: AT, updated_at: AT,
};
const collection = "/api/v1/evidence/objects";
const current = collection + "/" + object.id;
const cap = (feature: string, org_wide = true): S["MeAuthzCapability"] =>
  ({ feature, permission: "allow", branch_scope: { kind: "all" }, org_wide, scoped: !org_wide });

async function setup(page: Page, caps: S["MeAuthzCapability"][]) {
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
  const screen = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: caps } });
  return screen;
}

for (const width of [1440, 390]) test(`inspect and verify an evidence record and its hold at ${width}px`, async ({ page }) => {
  const screen = await setup(page, [cap("documents"), cap("role_manage")]);
  await page.setViewportSize({ width, height: 900 });
  let holds: S["LegalHoldRecordView"][] = [];
  let release: unknown;
  await mockRoute(page, "get", collection, { status: 200, json: { items: [object], as_of: 5, next_cursor: null, total: 1, offset: 0, limit: 25 } });
  await page.route(url => url.pathname === current, route => route.fulfill({ json: {
    object: { ...object, legal_hold_state: holds.some(h => h.status === "ACTIVE") ? "ACTIVE" : "CLEAR" },
    copies: [], legal_holds: holds, custody_history: [], tsa_proofs: [], exports: [],
  } }));
  await page.route(url => url.pathname === current + "/verify", route => route.fulfill({ json: {
    evidence_object_id: object.id, verified_at: AT, outcome: "MISMATCH", copies: [{ copy_id: id(22), copy_kind: "ORIGINAL", recorded_digest_sha256: "a".repeat(64),
      storage_checksum_sha256: "b".repeat(64), recorded_size_bytes: 200, storage_size_bytes: 200, status: "MISMATCH" }],
  } }));
  await page.route(url => url.pathname === current + "/hold", route => {
    const body = route.request().postDataJSON() as S["EvidenceHoldRequest"];
    if (body.op === "apply") {
      holds = [{ id: id(13), evidence_object_id: object.id, status: "ACTIVE", applied_by: id(1), applied_at: AT,
        reason: body.reason, case_ref: body.case_ref, basis: body.basis }];
    } else {
      if (body.four_eyes_request_ref !== id(14)) return route.fulfill({ status: 403, json: failure("four_eyes_required") });
      release = body;
      holds = [{ ...holds[0]!, status: "RELEASED", release_reason: body.reason }];
    }
    return route.fulfill({ status: body.op === "apply" ? 201 : 200, json: holds[0] });
  });
  await page.goto("/audit/evidence");
  const grid = page.getByRole("grid", { name: "Evidence vault" });
  if (width === 390) {
    await expect(page.getByRole("button", { name: "Verify copies" })).toHaveCount(0);
    await grid.getByRole("rowheader", { name: object.title }).click();
  }
  await page.getByRole("button", { name: "Verify copies" }).click();
  await expect(page.getByText("Mismatch", { exact: true })).toBeVisible();
  await expect(page.getByText("b".repeat(64))).toBeVisible();
  await page.getByRole("button", { name: "Apply hold", exact: true }).click();
  await page.getByLabel("Case reference").fill("CASE-42");
  await page.getByLabel("Basis", { exact: false }).fill("Preservation order");
  await page.getByLabel("Reason", { exact: false }).fill("Preserve the receipt");
  await page.locator("[data-composer-root]").getByRole("button", { name: /apply/i }).click();
  await expect(page.getByText("Hold applied.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Release hold", exact: true }).click();
  await page.getByLabel("Approved release request ID").fill(id(15));
  await page.getByLabel("Reason", { exact: false }).fill("Order ended");
  await page.locator("[data-composer-root]").getByRole("button", { name: /end/i }).click();
  await expect(page.getByRole("alert")).toContainText("Use the approval for this hold");
  expect(holds[0]?.status).toBe("ACTIVE");
  expect(release).toBeUndefined();
  await page.getByLabel("Approved release request ID").fill(id(14));
  await page.locator("[data-composer-root]").getByRole("button", { name: /end/i }).click();
  await expect.poll(() => release).toEqual({ op: "release", hold_id: id(13), four_eyes_request_ref: id(14), reason: "Order ended" });
  await expect(page.getByText("Order ended")).toBeVisible();
  await fits(page, "evidence record");
  await expectAxe(page, "evidence vault");
  expect(screen.unexpected).toEqual([]);
});

test("unserved or scoped evidence grants prevent the register read", async ({ page }) => {
  const screen = await setup(page, [cap("evidence_attach"), cap("documents", false)]);
  await page.goto("/audit/evidence");
  await expect(page.getByRole("button", { name: "Verify copies" })).toHaveCount(0);
  await expect(page.locator("main")).toContainText(/access|permission/i);
  expect(screen.unexpected).toEqual([]);
});

test("a failed register read can retry into an empty searchable vault", async ({ page }) => {
  const screen = await setup(page, [cap("documents")]);
  await installFaultClock(page, request => new URL(request.url()).pathname === collection);
  let ready = false;
  await page.route(url => url.pathname === collection, route => route.fulfill(ready ? {
    json: { items: [], limit: 25, offset: 0, total: 0, next_cursor: null, as_of: 0 },
  } : { status: 503, json: failure("unavailable") }));
  await page.goto("/audit/evidence");
  const retry = page.getByRole("button", { name: "Reload", exact: true });
  await expect(retry).toBeVisible();
  ready = true;
  await retry.click();
  await expect(page.getByText("No evidence found")).toBeVisible();
  expect(screen.unexpected).toEqual([]);
});

test("an org-wide reader follows the register snapshot and can verify without managing holds", async ({ page }) => {
  const screen = await setup(page, [cap("documents"), cap("role_manage", false)]);
  const second = { ...object, id: id(43), code: "EV-043", title: "Expense receipt" };
  const queries: URLSearchParams[] = [];
  let reply!: () => void;
  const firstPage = new Promise<void>(resolve => { reply = resolve; });
  await page.route(url => url.pathname === collection, async route => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    await firstPage;
    const next = query.has("cursor");
    await route.fulfill({ json: { items: [next ? second : object], as_of: 7, next_cursor: next ? null : "opaque_token", total: 2, offset: 0, limit: 25 } });
  });
  await mockRoute(page, "get", "/api/v1/evidence/objects/{id}", request => new URL(request.url()).pathname === current ? { status: 200, json: {
    object, legal_holds: [], copies: [], custody_history: [], tsa_proofs: [], exports: [],
  } } : { status: 403, json: failure("access_denied") });
  await page.route(url => url.pathname === current + "/verify", route => route.fulfill({ status: 503, json: failure("evidence_store_unavailable") }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/audit/evidence");
  await expect(page.getByRole("status", { name: "Loading…" })).toBeVisible();
  await expect.poll(() => queries.length).toBe(1);
  reply();
  const verify = page.getByRole("button", { name: "Verify copies" });
  await verify.click();
  await expect(page.getByText("Evidence storage is unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply hold" })).toHaveCount(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("rowheader", { name: second.title })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("You don’t have access to this item");
  await expect(verify).toHaveCount(0);
  expect(queries.at(-1)?.get("cursor")).toBe("opaque_token");
  expect(queries.at(-1)?.get("as_of")).toBe("7");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(verify).toBeVisible();
  expect(queries.at(-1)?.has("cursor")).toBe(false);
  expect(queries.at(-1)?.get("as_of")).toBe("7");
  expect(screen.unexpected).toEqual([]);
});
