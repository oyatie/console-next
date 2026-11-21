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
  saeonCertificates,
  saeonEmployeeDetail,
  saeonEmployeeFacets,
  saeonEmploymentFacts,
  saeonEndOptions,
  saeonFieldReveal,
  saeonFilterEmployees,
  saeonLegalEntities,
  saeonLifecycleEvents,
  saeonOrgStructure,
  saeonOrgUnits,
  saeonPayslipDraft,
  saeonPersonMonthAttendance,
  saeonPersonRecords,
  saeonPersonalFacts,
  saeonReasonCodes,
  saeonRegisterFacts,
  saeonRrnReveal,
  saeonRrnStatus,
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
    ? ["/people", "/people/$id", "/people/bulk", "/people/notices", "/people/exits", "/people/unplaced", "/people/certificates", "/org", "/attendance", "/payroll"]
    : ["/people", "/people/$id"];
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
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: {
      ...screenAccess("/people"),
      decisions: {
        ...screenAccess("/people").decisions,
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
  await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: saeonEmployeeFacets() });
  await mockRoute(page, "get", "/api/v1/employees", req => ({
    status: 200,
    json: saeonFilterEmployees(new URL(req.url()).searchParams),
  }));
  await mockRoute(page, "get", "/api/v1/employees/import/unplaced", {
    status: 200,
    json: { count: 0, next_cursor: null, items: [] },
  });
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

  await mockRoute(page, "get", "/api/v1/hr/certificates", req => {
    if (!canManage) return { status: 403, json: failure("forbidden") };
    const empId = new URL(req.url()).searchParams.get("employee_id") ?? "";
    return { status: 200, json: saeonCertificates(empId) };
  });
  await mockRoute(page, "get", "/api/v1/hr/certificates/precondition", {
    status: 200,
    json: { settings_configured: true, reason_code: null },
  });
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
  await mockRoute(page, "get", "/api/v1/hr/exit-cases", {
    status: 200,
    json: { items: [], total: 0, limit: 100, offset: 0 },
  });
  await mockRoute(page, "get", "/api/v1/employment-assignments", {
    status: 200,
    json: { items: [] },
  });

  return fixture;
}
