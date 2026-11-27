// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY, THEME_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { screens } from "../states/registry";
import { AT, id, modules, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { saeonAdminToken, saeonAdminUser, saeonLegalEntities, saeonPayGroups, saeonPayrollRates, saeonPayrollRunDetail, saeonUniverse } from "./saeon";
import { saeonAttendanceScheduleTree } from "./attendance-saeon";
import { saeonAttendanceCloses } from "./saeon-mod5-6";
import saeon from "./saeon-universe.json" with { type: "json" };
import { mockScreen } from "./screen";

const SHOT_DIR = process.env.M5_SHOT_DIR ?? "";

test.beforeAll(() => loadCatalog("ko"));

async function initCaptureConsole(page: Page) {
  await page.addInitScript(
    ({ expKey, themeKey }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem(themeKey, "light");
      localStorage.setItem("console.locale", "ko");
    },
    { expKey: EXPERIENCE_KEY, themeKey: THEME_KEY },
  );
}

async function applyBaseSaeonShell(page: Page) {
  const actor = { ...saeonAdminUser(), sign_in_id: "seoyeon.moon@saeon.test" };
  const allAccess = screenAccess("/");
  allAccess.is_ops = true;
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: actor });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: allAccess });
  await mockRoute(page, "get", "/api/v1/onboarding/modules", { status: 200, json: [...modules.ready, { key: "payroll", ready: true, unblock: null }] });
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: saeonLegalEntities() });
  await mockRoute(page, "get", "/api/v1/branches", {
    status: 200,
    json: saeon.entities[0]!.workplaces.slice(0, 3).map(w => ({
      id: id(120 + saeon.entities[0]!.workplaces.indexOf(w)),
      region_id: id(110),
      name: w.name,
      deactivated_at: null,
      created_at: "2026-01-01T00:00:00Z",
    })),
  });
}

async function waitForChromeAndFonts(page: Page, width: 1440 | 390) {
  if (width === 390) {
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("button", { name: t("shell.jumpLabel"), exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true })).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
}

async function captureBothThemes(page: Page, width: 1440 | 390, name: string) {
  await waitForChromeAndFonts(page, width);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(
      ([nextTheme, themeKey]) => {
        localStorage.setItem(themeKey, nextTheme);
        document.documentElement.dataset.theme = nextTheme;
      },
      [theme, THEME_KEY] as const,
    );
    await page.waitForTimeout(80);
    await fits(page, `${name}/${width}/${theme}`);
    await expectAxe(page, `${name}/${width}/${theme}`);
    const outDir = resolve(SHOT_DIR, String(width));
    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: resolve(outDir, `${name}-${theme}.png`), fullPage: true });
  }
}

if (SHOT_DIR) {
  for (const width of [1440, 390] as const) {
    test(`capture M5-UI console screens batch A at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await initCaptureConsole(page);
      const fixture = await mockScreen(page, screens[0], "populated");
      try {
        await applyBaseSaeonShell(page);

        // 1. settings (/settings?section=approvals)
        await mockRoute(page, "get", "/api/v1/tenant/company-domain/request", { status: 200, json: { pending_domain: null } });
        await mockRoute(page, "get", "/api/v1/employee-number-rules", { status: 200, json: [{ scope_kind: "TENANT", scope_id: id(1), prefix: "E-", width: 4, next_number: "E-0100" }] });
        await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: false, items: [] } });
        await mockRoute(page, "get", "/api/v1/roster-fields", { status: 200, json: { can_manage: false, active_limit: 20, items: [] } });
        await mockRoute(page, "get", "/api/v1/period-locks", { status: 200, json: { items: [] } });
        await page.route("**/api/v1/settings/*/history*", route =>
          route.fulfill({
            json: {
              items: [{ id: id(201), value: "route", previous_value: "none", direction: "tighten", effective_from: "2026-10-01T00:00:00Z", changed_at: "2026-09-28T05:00:00Z", actor_name: saeon.adminActor.name, reason_code: "POLICY_REVIEW", reason_note: null }],
              next_cursor: null,
            },
          }),
        );
        await mockRoute(page, "get", "/api/v1/settings", {
          status: 200,
          json: {
            can_change: true,
            items: [
              { key: "approval.policy.org_structure", kind: { type: "code", allowed: ["route", "none"] }, default: "none", value: "route", looser_when: "higher", governance: "tenant", legal_basis: { authority: saeon.entities[0]!.name, title: t("settingsHub.inspector.legalBasis"), url: "https://www.law.go.kr" }, version: { override: id(200) }, effective_from: "2026-10-01T00:00:00Z", source: { layer: "tenant", scope_entity_id: null }, chain: [{ layer: "tenant", scope_entity_id: null, value: "route", effective_from: null, deciding: true }], scheduled: [] },
              { key: "approval.policy.exit", kind: { type: "code", allowed: ["route", "none"] }, default: "route", value: "route", looser_when: "higher", governance: "tenant", legal_basis: null, version: { override: id(201) }, effective_from: null, source: { layer: "tenant", scope_entity_id: null }, chain: [{ layer: "tenant", scope_entity_id: null, value: "route", effective_from: null, deciding: true }], scheduled: [] },
              { key: "approval.policy.people_correction", kind: { type: "code", allowed: ["route", "none"] }, default: "none", value: "none", looser_when: "higher", governance: "tenant", legal_basis: null, version: "code_default", effective_from: null, source: { layer: "code_default", scope_entity_id: null }, chain: [{ layer: "code_default", scope_entity_id: null, value: "none", effective_from: null, deciding: true }], scheduled: [] },
              { key: "approval.policy.identity_merge", kind: { type: "code", allowed: ["route"] }, default: "route", value: "route", looser_when: "higher", governance: "fixed", legal_basis: { authority: saeon.entities[0]!.name, title: t("settingsHub.inspector.legalBasis"), url: "https://www.law.go.kr" }, version: null, effective_from: null, source: { layer: "platform", scope_entity_id: null }, chain: [{ layer: "platform", scope_entity_id: null, value: "route", effective_from: null, deciding: true }], scheduled: [] },
              { key: "approval.policy.import_rollback", kind: { type: "code", allowed: ["route", "none"] }, default: "route", value: "route", looser_when: "higher", governance: "tenant", legal_basis: null, version: { override: id(202) }, effective_from: null, source: { layer: "tenant", scope_entity_id: null }, chain: [{ layer: "tenant", scope_entity_id: null, value: "route", effective_from: null, deciding: true }], scheduled: [] },
            ],
          },
        });
        await page.goto("/settings?section=approvals");
        await expect(page.locator('[data-pattern="settings"]')).toBeVisible();
        await expect(page.getByText(t("settingsHub.key.approval.policy.org_structure")).first()).toBeVisible();
        if (width === 1440) await expect(page.locator('[data-pane="record"]')).toBeVisible();
        await captureBothThemes(page, width, "settings");

        // 2. attendance-close
        const wpList = saeonUniverse.entities[0]!.workplaces.slice(0, 3);
        await mockRoute(page, "get", "/api/v1/branches", {
          status: 200,
          json: wpList.map(w => ({ id: w.id, region_id: id(110), name: w.name, deactivated_at: null, created_at: "2026-01-01T00:00:00Z" })),
        });
        await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", { status: 200, json: saeonAttendanceScheduleTree() });
        await mockRoute(page, "get", "/api/v1/attendance/closes", { status: 200, json: { month: "2026-10", ...saeonAttendanceCloses() } });
        await page.goto("/attendance?tab=close&month=2026-10");
        await expect(page.getByRole("grid", { name: t("attendance.tab.close"), exact: true })).toBeVisible();
        if (width === 1440) await expect(page.getByRole("button", { name: t("attendance.close.preflightRun"), exact: true })).toBeVisible();
        await captureBothThemes(page, width, "attendance-close");

        // 3. attendance-import
        await mockRoute(page, "get", "/api/v1/hr/attendance-import/summary", {
          status: 200,
          json: {
            items: [
              { run_id: id(401), status: "APPLIED", source_filename: `${wpList[1]!.name}_2026-10.xlsx`, source_format: "xlsx", source_sha256: "a".repeat(64), input_rows: 142, candidate_rows: 142, preserved_rows: 0, dry_run_summary: {}, apply_summary: {}, created_at: "2026-10-31T08:00:00Z", applied_at: "2026-10-31T08:15:00Z" },
              { run_id: id(402), status: "DRY_RUN", source_filename: `${wpList[2]!.name}_2026-10.csv`, source_format: "csv", source_sha256: "b".repeat(64), input_rows: 86, candidate_rows: 86, preserved_rows: 0, dry_run_summary: {}, apply_summary: {}, created_at: "2026-10-31T09:10:00Z", applied_at: null },
            ],
            total: 2,
            limit: 20,
            offset: 0,
          },
        });
        await page.goto("/attendance?tab=import");
        await expect(page.getByText(`${wpList[1]!.name}_2026-10.xlsx`)).toBeVisible();
        await captureBothThemes(page, width, "attendance-import");

        // 4. payroll
        const groups = saeonPayGroups();
        const detail = saeonPayrollRunDetail({ offset: 0, limit: 50 });
        await mockRoute(page, "get", "/api/v1/payroll/pay-groups", { status: 200, json: groups });
        await mockRoute(page, "get", "/api/v1/payroll/reference/rates", { status: 200, json: saeonPayrollRates() });
        await mockRoute(page, "get", "/api/v1/payroll/runs/{id}", { status: 200, json: detail });
        await page.goto(`/payroll/runs/${detail.run.id}`);
        await expect(page.locator('[data-pattern="register-totals"]')).toBeVisible();
        await captureBothThemes(page, width, "payroll");

        // 5. audit
        await mockRoute(page, "get", "/api/v1/audit/attestation", { status: 200, json: { org_id: id(2), ok: true, kind: "ok", unsealed_tail: false, first_bad_seq: null } });
        await page.route("**/api/audit*", route =>
          route.fulfill({
            json: {
              limit: 50,
              offset: 0,
              items: [
                { id: id(601), actor_display: saeon.adminActor.name, action: "settings.change", target_type: "setting", target_id: "approval.policy.exit", source: "web", outcome: "ALLOWED", branch_id: wpList[0]!.name, auth_method: "PASSKEY", device: "macOS · Safari", ip: "203.0.113.10", before_snap: { value: "route" }, after_snap: { value: "none" }, occurred_at: "2026-11-10T09:15:00Z" },
                { id: id(602), actor_display: saeon.hero.name, action: "access.grant.assign", target_type: "grant", target_id: saeon.attendanceMonth.members[0]!.name, source: "web", outcome: "ALLOWED", branch_id: wpList[1]!.name, ip: "203.0.113.12", occurred_at: "2026-11-10T08:40:00Z" },
                { id: id(603), actor_display: saeon.approval.queue[1]!.requester, action: "attendance.close.confirm", target_type: "close", target_id: "2026-10", source: "web", outcome: "ALLOWED", branch_id: wpList[0]!.name, ip: "203.0.113.14", occurred_at: "2026-11-09T17:30:00Z" },
                { id: id(604), actor_display: saeon.statusSamples.onLeave.name, action: "employee.export", target_type: "employee", target_id: "bulk-export", source: "web", outcome: "DENIED", anomaly: true, reason_code: "SCOPE_DENIED", ip: "198.51.100.44", occurred_at: "2026-11-09T14:05:00Z" },
              ],
            },
          }),
        );
        await page.goto("/audit");
        await expect(page.getByRole("grid", { name: t("audit.log.table"), exact: true })).toBeVisible();
        if (width === 1440) await expect(page.locator('[data-pane="record"]')).toBeVisible();
        await captureBothThemes(page, width, "audit");

        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });

    test(`capture M5-UI console screens batch B at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await initCaptureConsole(page);
      const fixture = await mockScreen(page, screens[0], "populated");
      try {
        await applyBaseSaeonShell(page);

        // 6. audit-access-log
        const reviewBase = { id: id(701), period: "2026-10", scope: "TENANT", reviewer: saeon.adminActor.name, started_at: "2026-11-01T01:00:00Z", reviewed_at: null, due: "2026-11-05T00:00:00Z", flags_seen: { sensitive_read: 2, large_export: 1 }, findings: [] };
        await page.route(url => url.pathname.startsWith("/api/v1/access/access-log"), route => {
          const p = new URL(route.request().url()).pathname;
          if (p.includes("/reviews/")) return route.fulfill({ json: reviewBase });
          return route.fulfill({
            json: {
              period: { key: "2026-10", from: "2026-10-01", to: "2026-11-01", time_zone: "Asia/Seoul", closed: true },
              totals: { events: 12, flagged: 2, by_flag: { sensitive_read: 2, bulk_subjects: 1 } },
              items: [
                { event_id: id(710), created_at: AT, occurred_at: "2026-10-28T06:20:00Z", actor_id: id(101), actor_name: saeon.approval.queue[1]!.steps[0]!.actor, principal_type: "TENANT_USER", action: "employee.rrn_reveal", target_type: "employee", subject_count: 1, ip: "203.0.113.10", outcome: "ALLOWED", export_purpose: saeon.privacyConsole.requestDetail, row_count: null, flags: ["sensitive_read"] },
                { event_id: id(711), created_at: AT, occurred_at: "2026-10-25T02:10:00Z", actor_id: id(102), actor_name: saeon.approval.queue[1]!.requester, principal_type: "TENANT_USER", action: "employee.field_reveal", target_type: "employee", subject_count: 18, ip: "203.0.113.18", outcome: "ALLOWED", export_purpose: saeon.approval.queue[1]!.summary, row_count: null, flags: ["sensitive_read", "off_hours"] },
                { event_id: id(712), created_at: AT, occurred_at: "2026-10-22T05:45:00Z", actor_id: id(103), actor_name: saeon.hero.name, principal_type: "TENANT_USER", action: "employee.export", target_type: "employee", subject_count: 240, ip: "203.0.113.21", outcome: "ALLOWED", export_purpose: saeon.entities[0]!.name, row_count: 240, flags: ["download", "bulk_subjects"] },
                { event_id: id(713), created_at: AT, occurred_at: "2026-10-19T08:05:00Z", actor_id: id(104), actor_name: saeon.statusSamples.onLeave.name, principal_type: "TENANT_USER", action: "employee.export_refused", target_type: "employee", subject_count: 1, ip: "198.51.100.44", outcome: "DENIED", export_purpose: null, row_count: null, flags: ["repeated_denial"] },
              ],
              next_cursor: null,
              filter_options: { actors: [], actions: [], target_types: [] },
            },
          });
        });
        await page.goto("/audit/access-log?period=2026-10");
        await expect(page.getByRole("grid", { name: t("accessLog.table"), exact: true })).toBeVisible();
        if (width === 1440) await expect(page.locator('[data-pane="record"]')).toBeVisible();
        await captureBothThemes(page, width, "audit-access-log");

        // 7. access-review
        await mockRoute(page, "get", "/api/v1/access/roles", { status: 200, json: [] });
        await mockRoute(page, "get", "/api/v1/access/ops", {
          status: 200,
          json: {
            account_id: id(20),
            display_name: saeon.accessConsole.opsAccountName,
            max_holders: 2,
            holders: [{ account_id: id(20), display_name: saeon.accessConsole.opsAccountName, has_passkey: true, has_recovery_contact: true, recovery_codes_remaining: 10, designated_at: "2026-01-01T00:00:00Z" }],
          },
        });
        const wps = saeonUniverse.entities[0]!.workplaces;
        await mockRoute(page, "get", "/api/v1/access/grants", {
          status: 200,
          json: [
            { id: id(811), account_id: id(101), account_display_name: saeon.adminActor.name, account_employee_number: "10204", account_active: true, account_has_passkey: true, account_unit: saeon.adminActor.unit, role_id: id(901), role_name_ko: saeon.accessConsole.roleName, scope: { kind: "TENANT", include_descendants: true }, enforcement: "ENFORCED", effective_in_setup: false, reason_code: "OTHER", granted_by: id(101), valid_from: "2026-01-01", valid_to: "2026-12-31", activates_at: null, granted_at: "2026-01-01T00:00:00Z" },
            { id: id(812), account_id: id(102), account_display_name: saeon.approval.queue[1]!.requester, account_employee_number: "10311", account_active: true, account_has_passkey: true, account_unit: wps[1]!.name, role_id: id(902), role_name_ko: saeon.accessConsole.readOnlyRole, scope: { kind: "WORKPLACE", node_id: wps[1]!.id, node_name: wps[1]!.name, include_descendants: true }, enforcement: "ENFORCED", effective_in_setup: false, reason_code: "OTHER", granted_by: id(101), valid_from: "2026-03-01", valid_to: null, activates_at: null, granted_at: "2026-03-01T00:00:00Z" },
            { id: id(813), account_id: id(103), account_display_name: saeon.attendanceMonth.members[4]!.name, account_employee_number: saeon.attendanceMonth.members[4]!.employeeNumber, account_active: true, account_has_passkey: true, account_unit: wps[0]!.name, role_id: id(903), role_name_ko: saeon.accessConsole.opsAccountName, scope: { kind: "WORKPLACE", node_id: wps[0]!.id, node_name: wps[0]!.name, include_descendants: true }, enforcement: "PREPARED", effective_in_setup: true, reason_code: "OTHER", granted_by: id(101), valid_from: "2026-11-01", valid_to: "2027-05-01", activates_at: null, granted_at: "2026-10-20T00:00:00Z" },
            { id: id(814), account_id: id(104), account_display_name: saeon.attendanceMonth.members[0]!.name, account_employee_number: saeon.attendanceMonth.members[0]!.employeeNumber, account_active: true, account_has_passkey: true, account_unit: wps[2]!.name, role_id: id(904), role_name_ko: saeon.accessConsole.readOnlyRole, scope: { kind: "TENANT", include_descendants: false }, enforcement: "SCHEDULED", effective_in_setup: false, reason_code: "OTHER", granted_by: id(101), valid_from: "2026-12-01", valid_to: "2027-11-30", activates_at: "2026-12-01", granted_at: "2026-11-02T00:00:00Z" },
          ],
        });
        await page.goto("/access/review");
        await expect(page.getByRole("grid", { name: t("accessReview.table"), exact: true })).toBeVisible();
        if (width === 1440) {
          await expect(
            page.locator('[data-pane="record"]').getByRole("link", { name: t("accessReview.action.editPeriod"), exact: true }),
          ).toBeVisible();
        }
        await captureBothThemes(page, width, "access-review");

        // 8, 9, 10. privacy, privacy-intake, privacy-intake-workbench
        const reqId1 = id(801);
        const reqId2 = id(802);
        const rec1 = { id: reqId1, receipt_no: "RR-M5-001", detail: saeon.privacyConsole.requestDetail, status: "RECEIVED" as const, receipt: { controller: "TENANT" as const, received_on: "2026-11-01", identity_at: "2026-11-01T00:00:00Z" }, kinds: { CORRECTION: { due: { on: "2026-11-11", without_delay: false, rule: null }, decisions: [] }, ACCESS: { due: { on: "2026-11-11", without_delay: false, rule: null }, decisions: [] } } };
        const rec2 = { id: reqId2, receipt_no: "RR-M5-002", detail: saeon.approval.queue[2]!.summary, status: "RECEIVED" as const, receipt: { controller: "TENANT" as const, received_on: "2026-11-03", identity_at: "2026-11-03T00:00:00Z" }, kinds: { ACCESS: { due: { on: "2026-11-13", without_delay: false, rule: null }, decisions: [] } } };
        await mockRoute(page, "post", "/api/v1/auth/privacy-consent/status", { status: 200, json: { accepted: true, policy_version: "2026-10-01", privacy: { version: "2026-10-01", sha256: "0".repeat(64) }, terms: { version: "2026-10-01", sha256: "0".repeat(64) } } });
        await mockRoute(page, "get", "/api/v1/me/access-log", {
          status: 200,
          json: {
            items: [
              { event_id: id(91), actor_name: saeon.adminActor.name, actor_team: saeon.adminActor.unit, field: "PHONE", action: "VIEW", reason_code: "IDENTITY_VERIFICATION", occurred_at: "2026-11-10T03:15:00Z", target_type: "EMPLOYEE" },
              { event_id: id(92), actor_name: saeon.privacyConsole.secondaryActor, actor_team: saeon.adminActor.unit, field: "ADDRESS", action: "VIEW", reason_code: "DATA_SUBJECT_ACCESS", occurred_at: "2026-11-09T06:40:00Z", target_type: "EMPLOYEE" },
            ],
            next_cursor: null,
          },
        });
        await mockRoute(page, "get", "/api/v1/settings", {
          status: 200,
          json: { can_change: false, items: [{ key: "people.void_pii_retention", kind: { type: "int", unit: "days" }, default: 30, value: 30, looser_when: "higher", governance: "tenant", legal_basis: null, version: "code_default", effective_from: null, scheduled: [], source: { layer: "code_default", scope_entity_id: null }, chain: [] }] },
        });
        await mockRoute(page, "get", "/api/v1/reason-codes", {
          status: 200,
          json: { domain: "privacy_identity_method", items: [{ code: "ID_DOCUMENT_SEEN", system: true, active: true, requires_note: false, involuntary: false, notice_required: false, label_ko: null, label_en: null }] },
        });
        await page.route(url => url.pathname.startsWith("/api/v1/privacy/rights-requests"), route => {
          const p = new URL(route.request().url()).pathname;
          if (p.endsWith("/options")) return route.fulfill({ json: { subject_user_id: saeonAdminUser().id, as_of: "2026-11-05", controllers: [{ code: "TENANT" }], kinds: [{ code: "ACCESS", due_on: "2026-11-22", without_delay: false }], detail_max_length: 2000, reply_email_masked: "m***@saeon.test" } });
          if (p.endsWith("/mine")) return route.fulfill({ json: { items: [rec1], next_cursor: null, as_of: "2026-11-05" } });
          if (p.endsWith(`/rights-requests/${reqId1}`)) return route.fulfill({ json: { request: rec1, subject_name: saeon.privacyConsole.secondaryActor, as_of: "2026-11-05" } });
          if (p.endsWith(`/rights-requests/${reqId2}`)) return route.fulfill({ json: { request: rec2, subject_name: saeon.attendanceMonth.members[2]!.name, as_of: "2026-11-05" } });
          return route.fulfill({ json: { items: [{ request: rec1, subject_name: saeon.privacyConsole.secondaryActor }, { request: rec2, subject_name: saeon.attendanceMonth.members[2]!.name }], next_cursor: null, as_of: "2026-11-05" } });
        });

        await page.goto("/account/privacy");
        await expect(page.getByText("RR-M5-001", { exact: true })).toBeVisible();
        await captureBothThemes(page, width, "privacy");

        await page.goto("/account/privacy?view=intake");
        await expect(page.getByText("RR-M5-001", { exact: true })).toBeVisible();
        if (width === 1440) await expect(page.getByRole("heading", { name: t("privacy.intake.decisionsTitle"), exact: true })).toBeVisible();
        await captureBothThemes(page, width, "privacy-intake");

        await page.goto(`/account/privacy/intake/${reqId1}`);
        await expect(page.locator('[data-pattern="record"]')).toBeVisible();
        await captureBothThemes(page, width, "privacy-intake-workbench");

        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}
