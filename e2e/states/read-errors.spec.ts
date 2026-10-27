// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { accountReads } from "../mock/account";
import { AT, failure, id, user } from "../mock/fixtures";
import { mockPeopleImport } from "../mock/people-import";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

const run: components["schemas"]["EmployeeImportRun"] = {
  id: id(4000), source_filename: "synthetic-roster.xlsx", status: "APPLIED", apply_job_state: "done",
  created_at: AT, applied_at: AT, applied_by: { id: user.id, name: user.display_name },
  apply_summary: { input_rows: 1, inserted: 1, updated: 0, skipped: 0, companies: [] },
  rolled_back_at: null, rolled_back_by: null, rollback_reason_code: null, rollback_note: null,
  rollback: { job: null, refusal_code: null, mode: "GOVERNED", window_until: null, window_days: 14, pending_request: null },
  allowed: ["preview_rollback"],
};
const plan: components["schemas"]["EmployeeImportRollbackPreview"] = {
  run_id: run.id, mode: "GOVERNED", basis: "SECOND_PERSON", window_until: null, window_days: 14,
  preview_digest: "a".repeat(64), allowed: ["rollback"], blockers: [], rows: [],
};
const certificate = (n: number): components["schemas"]["CertificatePage"]["items"][number] => ({
  id: id(n), employee_id: id(100), certificate_no: `TEST-${n}`, name: "검증직원", kind: "EMPLOYMENT",
  purpose: "제출", issued_at: AT, voided_at: null, replaces_id: null,
});

test.beforeAll(() => loadCatalog("ko"));

for (const screen of ["support", "certificates", "rollback-reasons", "passkey-policy", "notice-candidates"] as const) {
  for (const status of [503, 403] as const) test(`${screen}: ${status} uses the shared read state @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = screen === "rollback-reasons" ? await mockPeopleImport(page, "populated") : await mockScreen(page, screens[2], "populated");
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
    let failing = true;
    let attempts = 0;
    const problem = { error: { ...failure(status === 403 ? "forbidden" : "read_outage").error, message: "raw upstream detail", support_ref: id(98), support_ref_at: AT } };
    const read = screen === "support" ? "/api/v1/support-sessions/active" : screen === "certificates" ? "/api/v1/hr/certificates" : screen === "rollback-reasons" ? "/api/v1/reason-codes" : screen === "passkey-policy" ? "/api/v1/auth/passkeys/policy" : "/api/v1/appointment-notices/candidates";
    page.on("request", request => { if (new URL(request.url()).pathname === read) attempts++; });
    const fail = () => ({ status, json: problem });
    let path = "/org";
    if (screen === "support") {
      await mockRoute(page, "get", "/api/v1/support-sessions/active", () => failing ? fail() : { status: 200, json: { sessions: [], pending_count: 0, pending_approvals: [], can_approve: false } });
    } else if (screen === "certificates") {
      path = "/people/certificates";
      await mockRoute(page, "get", "/api/v1/hr/certificates", request => new URL(request.url()).searchParams.has("cursor")
        ? failing ? fail() : { status: 200, json: { items: [certificate(11)], next_cursor: null } }
        : { status: 200, json: { items: [certificate(10)], next_cursor: "next-page" } });
    } else if (screen === "rollback-reasons") {
      path = `/people/import?run=${run.id}`;
      await mockRoute(page, "get", "/api/v1/employee-import-runs/{run_id}", { status: 200, json: run });
      await mockRoute(page, "post", "/api/v1/employee-import-runs/{run_id}/rollback/preview", { status: 200, json: plan });
      await mockRoute(page, "get", "/api/v1/reason-codes", request => new URL(request.url()).searchParams.get("domain") === "import_rollback" && failing
        ? fail() : { status: 200, json: { domain: new URL(request.url()).searchParams.get("domain")!, items: [] } });
    } else if (screen === "passkey-policy") {
      path = "/account";
      await accountReads(page, "save-unchanged");
      await mockRoute(page, "get", "/api/v1/auth/passkeys/policy", () => failing ? fail() : { status: 200, json: { label_max_length: 80 } });
    } else {
      path = "/people/notices/new";
      await mockRoute(page, "get", "/api/v1/appointment-notices/candidates", () => failing ? fail() : { status: 200, json: { items: [], next_cursor: null } });
    }
    try {
      await page.goto(path);
      if (screen === "certificates") {
        await expect(page.getByRole("gridcell", { name: "TEST-10", exact: true })).toBeVisible();
        await page.getByRole("button", { name: t("empDoc.certificate.more"), exact: true }).click();
      }
      if (screen === "passkey-policy") await page.getByRole("button", { name: t("account.passkey.add"), exact: true }).click();
      const region = screen === "support" ? page.getByRole("region", { name: t("supportAccess.title"), exact: true })
        : screen === "passkey-policy" ? page.getByRole("dialog") : screen === "rollback-reasons" ? page.locator('section[aria-labelledby="import-rollback"]') : page.getByRole("main");
      if (status === 403) {
        const denied = region.getByRole("region", { name: t("common.denied.title.plain"), exact: true });
        await expect(denied).toBeVisible({ timeout: 20_000 });
        await expect(denied).toContainText("김권한담당");
        if (screen === "certificates") {
          await expect(region.getByRole("gridcell", { name: "TEST-10", exact: true })).toHaveCount(0);
          await expect(region.getByRole("button", { name: t("empDoc.certificate.more"), exact: true })).toHaveCount(0);
        }
      } else {
        const notice = region.getByRole(screen === "certificates" ? "status" : "alert").filter({ hasText: t(screen === "certificates" ? "common.read.stale" : "common.loadFailed.title") });
        await expect(notice).toHaveCount(1, { timeout: 20_000 });
        if (screen === "certificates") await expect(region.getByRole("alert")).toHaveCount(0);
        await expect(region.locator(`[data-support-reference="${id(98)}"]`)).toBeVisible();
        if (screen === "certificates") await expect(region.getByRole("gridcell", { name: "TEST-10", exact: true })).toBeVisible();
        await expect(notice).not.toContainText(t("requestOutcome.checking"));
        await expect(notice).not.toContainText("raw upstream detail");
        await expectAxe(page, `${screen}/${status}`);
        await fits(page, `${screen}/${status}`);
        const before = attempts;
        failing = false;
        await region.getByRole("button", { name: t("common.retry"), exact: true }).click();
        await expect(notice).toHaveCount(0);
        expect(attempts).toBeGreaterThan(before);
        if (screen === "certificates") await expect(region.getByRole("gridcell", { name: "TEST-11", exact: true })).toBeVisible();
        if (screen === "notice-candidates") await expect(region.getByText(t("notice.pick.empty"), { exact: true })).toBeVisible();
      }
      await expect(page.getByRole("navigation", { name: "주 메뉴", includeHidden: true })).toBeAttached();
      await expect(page.locator("body")).not.toContainText(t("requestOutcome.checking"));
      await expect(page.locator("body")).not.toContainText("raw upstream detail");
      if (status === 403) {
        await expectAxe(page, `${screen}/${status}`);
        await fits(page, `${screen}/${status}`);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("rollback availability refusal shows its reason without a read failure or retry @ui-state", async ({ page }) => {
  const fixture = await mockPeopleImport(page, "populated");
  await mockRoute(page, "get", "/api/v1/employee-import-runs/{run_id}", {
    status: 200, json: { ...run, allowed: [], rollback: { ...run.rollback, refusal_code: "import_rollback_blocked" } },
  });
  try {
    await page.goto(`/people/import?run=${run.id}`);
    const region = page.locator('section[aria-labelledby="import-rollback"]');
    await expect(region.getByRole("alert")).toContainText(t("import.error.import_rollback_blocked"));
    await expect(region).not.toContainText(t("common.loadFailed.title"));
    await expect(region.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
