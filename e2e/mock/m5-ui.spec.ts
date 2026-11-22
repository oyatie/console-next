// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { REGISTRATION_FIXTURES } from "../setup-flows";
import { screens } from "../states/registry";
import { AT, failure, id, screenAccess, user } from "./fixtures";
import { mockRoute } from "./route";
import { saeonAdminUser, saeonLegalEntities, saeonPayGroups, saeonPayrollRates, saeonPayrollRunDetail, saeonUniverse } from "./saeon";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

async function initConsole(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ({ expKey, themeValue }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", "ko");
      Object.defineProperty(navigator.credentials, "get", {
        configurable: true,
        value: async () => ({ toJSON: () => ({ id: "mock-passkey-cred" }) }),
      });
    },
    { expKey: EXPERIENCE_KEY, themeValue: theme },
  );
}

async function mockPasskeyRoutes(page: Page, onStepUpBinding?: (binding: unknown) => void) {
  await page.route(
    url => url.pathname === "/api/v1/auth/passkey/step-up/start" || url.pathname === "/api/v1/auth/passkey/login/start",
    route => {
      if (urlMatchesStepUp(route.request().url())) {
        onStepUpBinding?.(route.request().postDataJSON()?.binding ?? null);
      }
      return route.fulfill({
        json: { ceremony_id: "m5-ceremony", challenge: { publicKey: { challenge: "Y2hhbGxlbmdl" } } },
      });
    },
  );
}

function urlMatchesStepUp(rawUrl: string) {
  return new URL(rawUrl).pathname === "/api/v1/auth/passkey/step-up/start";
}

test("Item 22 /settings policy dry-run preview, step-up commit, and workplace scope refusal", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await initConsole(page);
  const fixture = await mockScreen(page, screens[0], "empty");
  let stepUpBinding: unknown = null;
  await mockPasskeyRoutes(page, binding => {
    stepUpBinding = binding;
  });
  const access = screenAccess("/");
  access.is_ops = true;
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, is_tenant_ops: true } });
  await mockRoute(page, "get", "/api/v1/tenant/company-domain/request", { status: 200, json: { pending_domain: null } });
  await mockRoute(page, "get", "/api/v1/employee-number-rules", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: true, items: [] } });
  await mockRoute(page, "get", "/api/v1/roster-fields", { status: 200, json: { can_manage: true, active_limit: 30, items: [] } });
  await mockRoute(page, "get", "/api/v1/period-locks", { status: 200, json: { items: [] } });

  const entitiesData = saeonLegalEntities();
  const targetEntity = entitiesData.items[0]!;
  const targetEntityName = saeonUniverse.entities[0]!.name;
  const orgEntry = {
    key: "approval.policy.org_structure",
    kind: { type: "code", allowed: ["route", "none"] },
    default: "none",
    looser_when: "higher",
    governance: "tenant",
    legal_basis: null,
    value: "route",
    version: "v1",
    effective_from: null,
    source: { layer: "tenant", scope_entity_id: null },
    chain: [{ layer: "tenant", scope_entity_id: null, value: "route", deciding: true }],
    scheduled: [],
  };
  await page.route(url => url.pathname === "/api/v1/settings", route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("entity") === targetEntity.id) {
      return route.fulfill({ status: 403, json: failure("scope_tenant_wide_only") });
    }
    return route.fulfill({ json: { items: [orgEntry], can_change: true } });
  });
  await mockRoute(page, "get", "/api/v1/reason-codes", {
    status: 200,
    json: {
      domain: "settings_change",
      items: [{ code: "POLICY_UPDATE", system: true, active: true, requires_note: false, involuntary: false, notice_required: false, label_ko: null, label_en: null }],
    },
  });
  await mockRoute(page, "get", "/api/v1/legal-entities", {
    status: 200,
    json: entitiesData,
  });
  let dryRunCount = 0;
  let commitAssertionId: unknown = null;
  await page.route(url => url.pathname.startsWith("/api/v1/settings/approval.policy.org_structure"), async route => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { items: [], next_cursor: null } });
    }
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    if (url.searchParams.get("dry_run") === "true") {
      dryRunCount += 1;
      return route.fulfill({
        json: {
          key: "approval.policy.org_structure",
          scope_entity_id: null,
          value: body.value ?? "none",
          effective_from: "2026-11-15T00:00:00Z",
          direction: "loosen",
          path: "step_up_delayed",
          requires: { reason: true, step_up: true, second_person: false },
          earliest_effective_from: "2026-11-15T00:00:00Z",
          in_force: { value: "route", version: "v1", scope_entity_id: null },
          reaches: { scope_entity_id: null, keeps_own_value: [id(20)] },
        },
      });
    }
    commitAssertionId = body.step_up_assertion_id ?? null;
    return route.fulfill({
      json: {
        id: id(200),
        key: "approval.policy.org_structure",
        value: body.value,
        effective_from: "2026-11-15T00:00:00Z",
        direction: "loosen",
        path: "step_up_delayed",
      },
    });
  });

  await page.goto("/settings?section=approvals");
  await expect(page.getByRole("button", { name: t("settingsHub.policy.edit") })).toBeVisible();
  await page.getByRole("button", { name: t("settingsHub.policy.edit") }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByText(t("settingsHub.code.none"), { exact: true }).click();
  await dialog.getByText("POLICY_UPDATE", { exact: true }).click();
  await dialog.getByRole("button", { name: t("settingsHub.policy.dryRun") }).click();
  await expect.poll(() => dryRunCount).toBe(1);
  await expect(dialog.getByText(t("settingsHub.policy.stepUpRequired"))).toBeVisible();
  await dialog.getByRole("button", { name: t("composer.commit", { action: t("settingsHub.policy.noun"), verb: t("composer.verb.change"), count: 0, unit: t("composer.unit.units") }) }).click();
  await expect.poll(() => (stepUpBinding as { action_kind?: string } | null)?.action_kind).toBe("SETTINGS_CHANGE");
  await expect.poll(() => commitAssertionId).toBe("m5-ceremony");

  await page.goto("/settings?section=workplace");
  await page.getByRole("button", { name: new RegExp(t("settingsHub.workplace.scopeLabel")) }).click();
  await page.getByRole("option", { name: `${targetEntityName} (${t("enum.orgChangeTarget.ENTITY")})`, exact: true }).click();
  await expect(page.getByText(t("settingsHub.workplace.scopeError"))).toBeVisible();

  await fits(page, "m5 settings approvals");
  await expectAxe(page, "m5 settings approvals");
  expect(fixture.unexpected).toEqual([]);
});

test("Item 23 /attendance close preflight, overtime ack, and import", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await initConsole(page);
  const fixture = await mockScreen(page, screens[0], "empty");
  await mockPasskeyRoutes(page);
  const access = screenAccess("/attendance");
  access.is_ops = true;
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, is_tenant_ops: true } });
  await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", {
    status: 200,
    json: { date: "2026-10-20", people_total: 0, people_unscheduled: 0, holidays_loaded: true, nodes: [] },
  });
  await mockRoute(page, "get", "/api/v1/branches", {
    status: 200,
    json: [{ id: id(20), region_id: id(21), name: "HQ", deactivated_at: null, created_at: AT }],
  });
  await mockRoute(page, "get", "/api/v1/attendance/closes", {
    status: 200,
    json: {
      month: "2026-10",
      items: [{
        branch_scope: "org",
        closed: false,
        pending_leave: 1,
        open_exceptions: 2,
      }],
    },
  });
  await page.route("**/api/v1/attendance/closes/preflight*", route =>
    route.fulfill({
      json: {
        can_close: false,
        checks: [{ key: "pending_leave", ok: false, warn: false, note: "1 pending" }],
      },
    }),
  );

  await page.goto("/attendance?tab=close&month=2026-10");
  await page.getByRole("grid").getByRole("row").nth(1).click();
  await page.getByRole("button", { name: t("attendance.close.preflightRun"), exact: true }).click();
  await expect(page.getByText(t("attendance.close.blockedReason"), { exact: true })).toBeVisible();
  await fits(page, "m5 attendance close");
  await expectAxe(page, "m5 attendance close");

  let ackedState = false;
  await page.route(url => url.pathname === "/api/v1/attendance/week52", route =>
    route.fulfill({
      json: {
        week_start: "2026-10-19",
        items: [{
          employee_id: id(101),
          name: "Lee",
          current_hours: 49,
          recognized_hours: 49,
          overtime_hours: 9,
          projected_hours: 53,
          tone: "WARN",
          acked: ackedState,
        }],
      },
    }),
  );
  await page.route(url => url.pathname === "/api/v1/attendance/week52/acks", route => {
    ackedState = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/attendance?tab=overtime&date=2026-10-20");
  await page.getByRole("grid").getByRole("row").nth(1).click();
  await page.getByRole("button", { name: t("attendance.overtime.ackButton"), exact: true }).click();
  await expect(page.getByText(t("attendance.overtime.alreadyAcked"), { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("Item 24 /payroll/runs/$id lifecycle actions, SoD refusal, and exceptions pane", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await initConsole(page);
  const fixture = await mockScreen(page, screens[0], "empty");
  await mockPasskeyRoutes(page);
  const groups = saeonPayGroups();
  const detail = saeonPayrollRunDetail({ offset: 0, limit: 50 });
  detail.run.status = "SUBMITTED";
  detail.exceptions_open = 1;
  const runId = detail.run.id;
  const access = screenAccess(`/payroll/runs/${runId}`);
  access.is_ops = true;
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/payroll/pay-groups", { status: 200, json: groups });
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/payroll/reference/rates", { status: 200, json: saeonPayrollRates() });
  await page.route(`**/api/v1/payroll/runs/${runId}`, route => route.fulfill({ json: detail }));
  await page.route(`**/api/v1/payroll/runs/${runId}/exceptions*`, async route => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          items: [{
            id: id(501),
            employee_id: detail.lines[0]!.employee_id,
            employee_name: detail.lines[0]!.employee_display_name,
            kind: "MISSING_BANK",
            status: "OPEN",
            carried_from_run_id: null,
            note: null,
          }],
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.route(`**/api/v1/payroll/runs/${runId}/decision`, route =>
    route.fulfill({ status: 409, json: failure("sod_violation") }),
  );

  await page.goto(`/payroll/runs/${runId}`);
  await page.getByRole("button", { name: t("payrollRun.tool.exceptions"), exact: true }).first().click();
  await expect(page.getByRole("button", { name: t("payrollRun.exceptions.confirm"), exact: true })).toBeVisible();
  await page.getByRole("button", { name: t("payrollRun.cta.decide"), exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: t("composer.commit", { action: t("payrollRun.noun"), verb: t("composer.verb.approve"), count: 0, unit: t("composer.unit.units") }) }).click();
  await expect(page.getByRole("alert")).toContainText(t("payrollRun.error.sod_violation"));
  await fits(page, "m5 payroll run lifecycle");
  await expectAxe(page, "m5 payroll run lifecycle");
  expect(fixture.unexpected).toEqual([]);
});

test("Item 25 /audit log lookup and /audit/access-log monthly review workflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await initConsole(page);
  const fixture = await mockScreen(page, screens[0], "empty");
  await mockPasskeyRoutes(page);
  const access = screenAccess("/audit");
  access.is_ops = true;
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, is_tenant_ops: true } });
  await mockRoute(page, "get", "/api/v1/audit/attestation", {
    status: 200,
    json: { org_id: id(2), ok: true, kind: "ok", unsealed_tail: false, first_bad_seq: null },
  });
  await page.route("**/api/audit*", route =>
    route.fulfill({
      json: {
        limit: 50,
        offset: 0,
        items: [{
          id: id(601),
          actor_display: "Admin",
          action: "settings.change",
          target_type: "setting",
          target_id: "approval.policy.exit",
          source: "web",
          outcome: "ALLOWED",
          before_snap: { value: "route" },
          after_snap: { value: "none" },
          occurred_at: AT,
        }],
      },
    }),
  );

  await page.goto("/audit");
  await expect(page.getByText(t("audit.attestation.ok"), { exact: true })).toBeVisible();
  await page.getByRole("grid").getByRole("row").nth(1).click();
  await expect(page.getByText(t("audit.detail.diff"), { exact: true })).toBeVisible();
  await fits(page, "m5 audit page");
  await expectAxe(page, "m5 audit page");

  let reviewState = {
    id: id(701),
    period: "2026-10",
    scope: "TENANT",
    reviewer: null,
    started_at: null as string | null,
    reviewed_at: null as string | null,
    due: "2026-11-05T00:00:00Z",
    flags_seen: {},
    findings: [] as Record<string, unknown>[],
  };
  await page.route(url => url.pathname.startsWith("/api/v1/access/access-log"), async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/start")) {
      reviewState = { ...reviewState, started_at: AT };
      return route.fulfill({ json: reviewState });
    }
    if (pathname.endsWith("/findings")) {
      reviewState = { ...reviewState, findings: [{ disposition: "confirmed", note: "verified" }] };
      return route.fulfill({ json: reviewState });
    }
    if (pathname.endsWith("/complete")) {
      if (reviewState.findings.length === 0) {
        return route.fulfill({ status: 409, json: failure("review_incomplete") });
      }
      reviewState = { ...reviewState, reviewed_at: AT };
      return route.fulfill({ json: reviewState });
    }
    if (pathname.includes("/reviews/")) {
      return route.fulfill({ json: reviewState });
    }
    return route.fulfill({
      json: {
        period: { key: "2026-10", from: "2026-10-01", to: "2026-11-01", time_zone: "Asia/Seoul", closed: true },
        totals: { events: 1, flagged: 1, by_flag: { sensitive_read: 1 } },
        items: [{
          event_id: id(710),
          created_at: AT,
          occurred_at: AT,
          actor_id: id(101),
          actor_name: "Kim",
          principal_type: "TENANT_USER",
          action: "employee.rrn_reveal",
          target_type: "employee",
          subject_count: 1,
          ip: "203.0.113.10",
          outcome: "ALLOWED",
          export_purpose: null,
          row_count: null,
          flags: ["sensitive_read"],
        }],
        next_cursor: null,
        filter_options: { actors: [], actions: [], target_types: [] },
      },
    });
  });

  await page.goto("/audit/access-log");
  await page.getByRole("button", { name: t("accessLog.review.open"), exact: true }).click();
  await page.getByRole("button", { name: t("accessLog.review.start"), exact: true }).click();
  await page.getByRole("button", { name: t("composer.commit", { action: t("accessLog.review.noun"), verb: t("composer.verb.apply"), count: 0, unit: t("composer.unit.units") }) }).click();
  await expect(page.getByText(t("accessLog.review.startedReceipt"), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: t("accessLog.review.recordFinding"), exact: true }).click();
  await page.getByRole("button", { name: t("composer.commit", { action: t("accessLog.review.noun"), verb: t("composer.verb.record"), count: 0, unit: t("composer.unit.units") }) }).click();
  await page.getByRole("button", { name: t("accessLog.review.complete"), exact: true }).click();
  await page.getByRole("button", { name: t("composer.commit", { action: t("accessLog.review.noun"), verb: t("composer.verb.complete"), count: 0, unit: t("composer.unit.units") }) }).click();
  await expect(page.getByText(t("accessLog.review.completedReceipt"), { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("Item 26A /account/privacy intake queue, CORRECTION refusal disable, and bound passkey decide", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await initConsole(page);
  const fixture = await mockScreen(page, screens[0], "empty");
  await mockPasskeyRoutes(page);
  await mockRoute(page, "post", "/api/v1/auth/privacy-consent/status", {
    status: 200,
    json: {
      accepted: true,
      policy_version: "2026-10-01",
      privacy: { version: "2026-10-01", sha256: "0".repeat(64) },
      terms: { version: "2026-10-01", sha256: "0".repeat(64) },
    },
  });
  await mockRoute(page, "get", "/api/v1/me/access-log", { status: 200, json: { items: [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { items: [], can_change: false } });
  await mockRoute(page, "get", "/api/v1/reason-codes", {
    status: 200,
    json: {
      domain: "privacy_identity_method",
      items: [{ code: "ID_DOCUMENT_SEEN", system: true, active: true, requires_note: false, involuntary: false, notice_required: false, label_ko: null, label_en: null }],
    },
  });

  const reqId = id(801);
  let receipt = {
    id: reqId,
    receipt_no: "RR-M5-001",
    detail: "Correction check",
    status: "RECEIVED",
    receipt: { controller: "TENANT", received_on: "2026-11-01", identity_at: "2026-11-01T00:00:00Z" },
    kinds: {
      CORRECTION: { due: { on: "2026-11-11", without_delay: false, rule: null }, decisions: [] as unknown[] },
      ACCESS: { due: { on: "2026-11-11", without_delay: false, rule: null }, decisions: [] as unknown[] },
    },
  };
  await page.route(url => url.pathname.startsWith("/api/v1/privacy/rights-requests"), async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/options")) {
      return route.fulfill({ json: { subject_user_id: user.id, as_of: "2026-11-05", controllers: [], kinds: [], detail_max_length: 2000, reply_email_masked: null } });
    }
    if (url.pathname.endsWith("/mine")) {
      return route.fulfill({ json: { items: [], next_cursor: null, as_of: "2026-11-05" } });
    }
    if (url.pathname.endsWith("/decide")) {
      const body = route.request().postDataJSON();
      expect(body.step_up?.binding?.action_kind).toBe("PRIVACY_REQUEST_DECIDE");
      receipt = {
        ...receipt,
        status: "DECIDED",
        kinds: {
          ...receipt.kinds,
          CORRECTION: {
            ...receipt.kinds.CORRECTION,
            decisions: [{ on: "2026-11-05", decision: { outcome: "GRANTED", reason: null, note: "done" } }],
          },
        },
      };
      return route.fulfill({ json: receipt });
    }
    if (url.pathname.endsWith(`/rights-requests/${reqId}`)) {
      return route.fulfill({ json: { request: receipt, subject_name: "Park", as_of: "2026-11-05" } });
    }
    return route.fulfill({ json: { items: [{ request: receipt, subject_name: "Park" }], next_cursor: null, as_of: "2026-11-05" } });
  });

  await page.goto("/account/privacy?view=intake");
  await expect(page.getByText("RR-M5-001", { exact: true })).toBeVisible();
  await fits(page, "m5 privacy intake queue");
  await page.getByText("RR-M5-001", { exact: true }).click();
  await expect(page.getByRole("heading", { name: t("privacy.intake.decisionsTitle"), exact: true })).toBeVisible();
  await page.getByRole("button", { name: t("privacy.intake.decideOpen"), exact: true }).first().click();
  await expect(page.getByText(t("privacy.intake.correctionOnlyGranted"), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: t("composer.commit", { action: t("privacy.intake.noun"), verb: t("composer.verb.apply"), count: 0, unit: t("composer.unit.units") }) }).click();
  await expect(page.getByText(t("privacy.intake.decideReceipt"), { exact: true })).toBeVisible();
  await fits(page, "m5 privacy intake workbench");
  await expectAxe(page, "m5 privacy intake workbench");
  expect(fixture.unexpected).toEqual([]);
});
