// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { screens } from "../states/registry";
import { contractWindowSettings } from "./directory";
import { authz, failure, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import {
  SAEON_HERO_ID,
  saeonAdminToken,
  saeonAdminUser,
  saeonCertificateDetail,
  saeonCertificateSettings,
  saeonCertificates,
  saeonEmployeeDetail,
  saeonEmployeeFacets,
  saeonEmploymentFacts,
  saeonEndOptions,
  saeonExitCaseCounts,
  saeonExitCaseDetail,
  saeonExitCases,
  saeonFieldReveal,
  saeonFilterEmployees,
  saeonImportDryRun,
  saeonImportPreview,
  saeonImportRuns,
  saeonLegalEntities,
  saeonLifecycleEvents,
  saeonNoticeCandidates,
  saeonNoticeDetail,
  saeonNotices,
  saeonOrgStructure,
  saeonOrgUnits,
  saeonPayslipDraft,
  saeonPersonMonthAttendance,
  saeonPersonRecords,
  saeonPersonalFacts,
  saeonReasonCodes,
  saeonRegisterFacts,
  saeonRegisterFactsBatch,
  saeonRrnReveal,
  saeonRrnStatus,
  saeonUnmappedCompanies,
  saeonUnplacedQueue,
} from "./saeon";
import { mockScreen } from "./screen";

type S = components["schemas"];

interface SetupSaeonPeopleOptions {
  theme?: "light" | "dark";
  locale?: "ko" | "en";
  experience?: "console" | "baseline";
  canManage?: boolean;
  modulesState?: "ready" | "not-ready" | "refused";
  passkeyStepUpMode?: "ok" | "step_up_required" | "refused";
  unplacedPopulated?: boolean;
}

function employeeIdFromPath(urlString: string, suffixSegments = 0): string {
  const parts = new URL(urlString).pathname.split("/").filter(Boolean);
  return parts[parts.length - 1 - suffixSegments]!;
}

export async function setupConsoleSaeonPeople(page: Page, options: SetupSaeonPeopleOptions = {}) {
  const {
    theme = "light",
    locale = "ko",
    experience = "console",
    canManage = true,
    modulesState = "ready",
    passkeyStepUpMode = "ok",
    unplacedPopulated = false,
  } = options;

  await page.addInitScript(
    ({ expKey, expValue, themeValue, localeValue }) => {
      localStorage.setItem(expKey, expValue);
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", localeValue);
      if (navigator.credentials) {
        Object.defineProperty(navigator.credentials, "get", {
          configurable: true,
          value: async () => {
            if (sessionStorage.getItem("cancel-passkey")) {
              throw new DOMException("Cancelled", "NotAllowedError");
            }
            return { toJSON: () => ({ id: "mock-passkey-credential" }) };
          },
        });
      }
    },
    { expKey: EXPERIENCE_KEY, expValue: experience, themeValue: theme, localeValue: locale },
  );

  const fixture = await mockScreen(page, screens[1], "populated", modulesState);

  const accessPaths = canManage
    ? [
        "/people",
        "/people/$id",
        "/people/new",
        "/people/run",
        "/people/bulk",
        "/people/renew",
        "/people/grid",
        "/people/notices",
        "/people/notices/new",
        "/people/notices/$noticeId",
        "/people/exits",
        "/people/exits/$id",
        "/people/import",
        "/people/unplaced",
        "/people/data-health",
        "/people/certificates",
        "/people/certificates/$certificateId",
        "/org",
        "/attendance",
        "/payroll",
      ]
    : ["/people", "/people/$id", "/people/data-health"];
  const accessEntries: S["AccessEffectiveEntry"][] = accessPaths.flatMap(path => screenAccess(path).entries);
  const dedupedEntries = accessEntries.filter(
    (entry, idx) =>
      accessEntries.findIndex(
        other => other.domain === entry.domain && other.level === entry.level && other.scope.kind === entry.scope.kind,
      ) === idx,
  );

  const extraCapabilities = canManage
    ? [
        "employee_directory_manage",
        "employee_rrn_reveal",
        "employee_pii_reveal",
        "hr_certificate_read",
        "attendance_read",
        "payroll_read",
        "exit_case_report",
        "exit_case_hr_confirm",
        "exit_case_hq_confirm",
        "exit_settlement_manage",
      ]
    : [];

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/me/authz", {
    status: 200,
    json: {
      ...authz,
      capabilities: [
        ...authz.capabilities,
        ...extraCapabilities.map(feature => ({
          feature,
          permission: "allow" as const,
          branch_scope: { kind: "all" as const },
          org_wide: true,
          scoped: false,
        })),
      ],
    },
  });
  const mergedDecisions = Object.assign({}, ...accessPaths.map(path => screenAccess(path).decisions));
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: {
      ...screenAccess("/people"),
      decisions: {
        ...mergedDecisions,
        ...(canManage ? { certificate_settings_manage: true } : {}),
      },
      entries: dedupedEntries,
    },
  });

  await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: contractWindowSettings(60) });
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: saeonLegalEntities() });
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: saeonOrgStructure() });
  await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: saeonOrgUnits() } });
  await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { items: [], can_manage: canManage } });
  await mockRoute(page, "get", "/api/v1/reason-codes", req => {
    const domain = new URL(req.url()).searchParams.get("domain") ?? "";
    return { status: 200, json: { domain, items: saeonReasonCodes(domain).map(x => ({ ...x, system: false })) } };
  });
  // Register {id} BEFORE literal 4-segment paths (/facets, /voided) because Playwright resolves routes LIFO.
  await mockRoute(page, "get", "/api/v1/employees/{id}", req => ({
    status: 200,
    json: saeonEmployeeDetail(employeeIdFromPath(req.url())),
  }));
  await mockRoute(page, "get", "/api/v1/employees/{id}/unit-position", req => {
    const emp = saeonEmployeeDetail(employeeIdFromPath(req.url(), 1)).employee;
    return { status: 200, json: { org_unit_id: emp.org_unit_id ?? null, index: 0, total: 0, prev_id: null, next_id: null, pre_hire_count: 0 } };
  });
  await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: saeonEmployeeFacets() });
  await mockRoute(page, "get", "/api/v1/employees", req => ({
    status: 200,
    json: saeonFilterEmployees(new URL(req.url()).searchParams),
  }));
  await mockRoute(page, "get", "/api/v1/employees/import/unplaced", () =>
    canManage
      ? { status: 200, json: unplacedPopulated ? saeonUnplacedQueue() : { count: 0, next_cursor: null, items: [] } }
      : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/employment-assignments/unmapped-companies", () =>
    canManage
      ? { status: 200, json: unplacedPopulated ? saeonUnmappedCompanies() : { items: [] } }
      : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "post", "/api/v1/employment-assignments/map-company", () =>
    canManage
      ? { status: 200, json: { company_text: "mapped", legal_entity_id: "00000000-0000-4000-8100-000000000001", workplace_id: "00000000-0000-4000-8200-000000000101", mapped: 2 } }
      : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/employee-number-rules", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/employee-import-runs/{run_id}", () =>
    canManage ? { status: 200, json: saeonImportRuns().items[0]! } : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/employee-import-runs", () =>
    canManage ? { status: 200, json: saeonImportRuns() } : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "post", "/api/v1/employees/import/preview", req => {
    if (!canManage) return { status: 403, json: failure("forbidden") };
    const rawBody = req.postData() ?? "";
    if (rawBody.includes("BaseSalary") && rawBody.includes('"target":"')) {
      return { status: 422, json: failure("mapping_restricted_column") };
    }
    return { status: 200, json: saeonImportPreview() };
  });
  await mockRoute(page, "post", "/api/v1/employees/import/{run_id}/dry-run", () =>
    canManage ? { status: 200, json: saeonImportDryRun() } : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/employees/voided", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/employees/{id}/personal-facts", req => ({
    status: 200,
    json: saeonPersonalFacts(employeeIdFromPath(req.url(), 1)),
  }));
  await mockRoute(page, "get", "/api/v1/employees/{id}/register-facts", req => ({
    status: 200,
    json: saeonRegisterFacts(employeeIdFromPath(req.url(), 1)),
  }));
  await mockRoute(page, "get", "/api/v1/employees/{id}/employment-facts", req => ({
    status: 200,
    json: saeonEmploymentFacts(employeeIdFromPath(req.url(), 1)),
  }));
  await mockRoute(page, "get", "/api/v1/employees/{id}/records", req => ({
    status: 200,
    json: saeonPersonRecords(employeeIdFromPath(req.url(), 1)),
  }));
  await mockRoute(page, "get", "/api/v1/employees/{id}/lifecycle-events", req => ({
    status: 200,
    json: saeonLifecycleEvents(employeeIdFromPath(req.url(), 1)),
  }));
  await mockRoute(page, "get", "/api/v1/employees/{id}/lifecycle-cases", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/employees/{id}/contracts", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/employees/{id}/end-options", req =>
    canManage
      ? { status: 200, json: saeonEndOptions(employeeIdFromPath(req.url(), 1)) }
      : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/employees/{id}/rrn", req =>
    canManage
      ? { status: 200, json: saeonRrnStatus(employeeIdFromPath(req.url(), 1)) }
      : { status: 403, json: failure("forbidden") },
  );

  await mockRoute(page, "post", "/api/v1/auth/passkey/step-up/start", () => {
    if (passkeyStepUpMode === "refused") {
      return { status: 403, json: failure("forbidden") };
    }
    return {
      status: 200,
      json: {
        ceremony_id: "saeon-rrn-ceremony",
        challenge: { publicKey: { challenge: "Y2hhbGxlbmdl" } },
        expires_at: "2026-11-10T01:00:00Z",
        binding: {
          action_kind: "RRN_REVEAL",
          object_id: SAEON_HERO_ID,
          reason_key: "INSURANCE_FILING",
          replay_attempt: null,
        },
      },
    };
  });
  await mockRoute(page, "post", "/api/v1/employees/{id}/rrn/reveal", req => {
    if (passkeyStepUpMode === "step_up_required") {
      return { status: 401, json: failure("step_up_required") };
    }
    if (passkeyStepUpMode === "refused" || !canManage) {
      return { status: 403, json: failure("forbidden") };
    }
    const empId = employeeIdFromPath(req.url(), 2);
    return { status: 200, json: { employee_id: empId, ...saeonRrnReveal(empId) } };
  });
  await mockRoute(page, "post", "/api/v1/employees/{id}/reveal", req => {
    if (passkeyStepUpMode === "step_up_required") {
      return { status: 401, json: failure("step_up_required") };
    }
    if (passkeyStepUpMode === "refused" || !canManage) {
      return { status: 403, json: failure("forbidden") };
    }
    const empId = employeeIdFromPath(req.url(), 1);
    const body = req.postDataJSON() as { field?: string } | null;
    const field = body?.field ?? "PHONE";
    return { status: 200, json: { employee_id: empId, field, ...saeonFieldReveal(empId, field) } as never };
  });

  // Parameterized {id} MUST be registered before literal /precondition (Playwright resolves LIFO).
  await mockRoute(page, "get", "/api/v1/hr/certificates/{id}", req =>
    canManage
      ? { status: 200, json: saeonCertificateDetail(employeeIdFromPath(req.url())) }
      : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/hr/certificates", req => {
    if (!canManage) return { status: 403, json: failure("forbidden") };
    const empId = new URL(req.url()).searchParams.get("employee_id") || SAEON_HERO_ID;
    return { status: 200, json: saeonCertificates(empId) };
  });
  await mockRoute(page, "get", "/api/v1/hr/certificates/precondition", {
    status: 200,
    json: { settings_configured: true, reason_code: null },
  });
  await mockRoute(page, "get", "/api/v1/hr/certificate-settings", () =>
    canManage ? { status: 200, json: saeonCertificateSettings() } : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "put", "/api/v1/hr/certificate-settings", req =>
    canManage
      ? { status: 200, json: { ...(req.postDataJSON() as Record<string, unknown>), version: 2 } as S["CertificateSettings"] }
      : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/attendance/people/{employee_id}/month", req => {
    const url = new URL(req.url());
    const empId = employeeIdFromPath(req.url(), 1);
    const month = url.searchParams.get("month") ?? "2026-11";
    return { status: 200, json: saeonPersonMonthAttendance(empId, month) };
  });
  await mockRoute(page, "get", "/api/v1/payroll/employees/{employeeId}/payslip-draft", req => {
    if (!canManage) return { status: 403, json: failure("forbidden") };
    return { status: 200, json: saeonPayslipDraft(employeeIdFromPath(req.url(), 1)) };
  });
  await mockRoute(page, "get", "/api/v1/directory/people", {
    status: 200,
    json: { items: [], limit: 100, offset: 0, total: 0 },
  });
  await mockRoute(page, "get", "/api/v1/person-binding-reviews", {
    status: 200,
    json: { items: [], limit: 100, offset: 0, total: 0 },
  });
  await mockRoute(page, "post", "/api/v1/employees/register-facts/query", req =>
    canManage
      ? { status: 200, json: saeonRegisterFactsBatch(req.postDataJSON() as S["RegisterFactsQueryRequest"] | null) }
      : { status: 403, json: failure("forbidden") },
  );
  // Register {id} before literal /counts and /bulk (Playwright resolves LIFO).
  await mockRoute(page, "get", "/api/v1/hr/exit-cases/{id}", req =>
    canManage
      ? { status: 200, json: saeonExitCaseDetail(employeeIdFromPath(req.url())) }
      : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/hr/exit-cases/counts", req =>
    canManage
      ? { status: 200, json: saeonExitCaseCounts(new URL(req.url()).searchParams.get("search") ?? undefined) }
      : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "post", "/api/v1/hr/exit-cases/bulk", req => {
    if (!canManage) return { status: 403, json: failure("forbidden") };
    const body = req.postDataJSON() as { items?: { employee_id: string }[] } | null;
    return { status: 200, json: { results: (body?.items ?? []).map(item => ({ employee_id: item.employee_id, ok: true })) } };
  });
  await mockRoute(page, "get", "/api/v1/hr/exit-cases", req => {
    if (!canManage) return { status: 200, json: { items: [], total: 0, limit: 100, offset: 0 } };
    const params = new URL(req.url()).searchParams;
    return {
      status: 200,
      json: saeonExitCases({
        status: params.get("status") ?? undefined,
        search: params.get("search") ?? undefined,
      }),
    };
  });
  await mockRoute(page, "get", "/api/v1/lifecycle-cases/{id}", req => ({
    status: 200,
    json: {
      id: employeeIdFromPath(req.url()),
      employee_id: SAEON_HERO_ID,
      kind: "EXIT",
      state: "OPEN",
      trigger_id: null,
      effective_date: "2026-11-30",
      linked_case_id: null,
      cancellation_reason: null,
      version: 1,
      items: [],
    },
  }));
  await mockRoute(page, "get", "/api/v1/lifecycle-case-templates/{key}", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/employees/{id}/exit-guards", {
    status: 200,
    json: { protected_periods: [], notice_required: false, refusal_code: null, notice_pay: null, protection_rules: [] },
  });
  // Register {id} before literal /candidates (Playwright resolves LIFO).
  await mockRoute(page, "get", "/api/v1/appointment-notices/{id}", req =>
    canManage
      ? { status: 200, json: saeonNoticeDetail(employeeIdFromPath(req.url())) }
      : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/appointment-notices/candidates", () =>
    canManage ? { status: 200, json: saeonNoticeCandidates() } : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/appointment-notices", () =>
    canManage ? { status: 200, json: saeonNotices() } : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "post", "/api/v1/appointment-notices", () =>
    canManage ? { status: 201, json: saeonNoticeDetail("00000000-0000-4000-8970-000000000001") } : { status: 403, json: failure("forbidden") },
  );
  await mockRoute(page, "get", "/api/v1/employment-assignments", {
    status: 200,
    json: { items: [] },
  });

  return fixture;
}
