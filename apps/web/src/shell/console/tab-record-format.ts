// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtMonth } from "@console/i18n/format";
import type { CachedRecordSpec } from "../../lib/react/cached-record";

type RecordKind =
  | "employee"
  | "identifiers"
  | "employeePay"
  | "exitCase"
  | "orgChange"
  | "approval"
  | "entity"
  | "payrollRun"
  | "certificate"
  | "notice"
  | "accessRole"
  | "accessPerson"
  | "attendanceScope";

export type RouteTabMeta = {
  title: string;
  isFallback: boolean;
  /** `node`: the one record of a collection read that the title names, which then follows the route's own title. */
  recordSpec: (CachedRecordSpec & { kind: RecordKind; node?: string }) | null;
};

/** A YYYY-MM month as its month alone, as the tab titles draw it, or null when it is not one. */
export function monthOnly(month: string | null | undefined): string | null {
  const name = fmtMonth(month, "name");
  return name === "—" ? null : name;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matchPathId(key: string, expectedId: string): (params: unknown) => boolean {
  return params => {
    if (!params || typeof params !== "object") return false;
    const rec = params as Record<string, unknown>;
    if (rec[key] === expectedId) return true;
    const nested = rec.path;
    return Boolean(nested && typeof nested === "object" && (nested as Record<string, unknown>)[key] === expectedId);
  };
}

export function resolveDynamicRouteMeta(path: string): RouteTabMeta | null {
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "account" && segs[1] === "privacy" && segs[2] === "intake" && segs[3]) {
    return { title: t("shellRoutes.privacyIntake"), isFallback: false, recordSpec: null };
  }
  if (segs[0] === "requests" && segs[1]) {
    return { title: t("shellRoutes.requestDetail"), isFallback: false, recordSpec: null };
  }
  if (segs[0] === "approvals" && segs[1]) {
    const id = safeDecode(segs[1]);
    return {
      title: t("shellRoutes.approvalDoc"),
      isFallback: true,
      recordSpec: { kind: "approval", path: "/api/v1/approvals/{id}", match: matchPathId("id", id) },
    };
  }
  if (segs[0] === "org" && segs[1] === "changes" && segs[2]) {
    const id = safeDecode(segs[2]);
    return {
      title: t("shellRoutes.orgChangeDetail"),
      isFallback: true,
      recordSpec: { kind: "orgChange", path: "/api/v1/org-changes/{id}", match: matchPathId("id", id) },
    };
  }
  if (segs[0] === "org" && segs[1] === "entities" && segs[2]) {
    if (segs[3] === "workplaces" && segs[4] === "new") {
      return { title: t("shellRoutes.workplaceNew"), isFallback: false, recordSpec: null };
    }
    if (!segs[3]) {
      const entityId = safeDecode(segs[2]);
      return {
        title: t("shellRoutes.entityDetail"),
        isFallback: true,
        recordSpec: { kind: "entity", path: "/api/v1/legal-entities/{entityId}", match: matchPathId("entityId", entityId) },
      };
    }
  }
  if (segs[0] === "people" && segs[1] === "exits" && segs[2]) {
    const id = safeDecode(segs[2]);
    return {
      title: t("shellRoutes.peopleExitDetail"),
      isFallback: true,
      recordSpec: { kind: "exitCase", path: "/api/v1/hr/exit-cases/{id}", match: matchPathId("id", id) },
    };
  }
  if (segs[0] === "people" && segs[1] === "certificates" && segs[2]) {
    const id = safeDecode(segs[2]);
    return {
      title: t("shellRoutes.peopleCertificate"),
      isFallback: true,
      recordSpec: { kind: "certificate", path: "/api/v1/hr/certificates/{id}", match: matchPathId("id", id) },
    };
  }
  if (segs[0] === "people" && segs[1] === "notices" && segs[2] && segs[2] !== "new") {
    const id = safeDecode(segs[2]);
    return {
      title: t("shellRoutes.peopleNotices"),
      isFallback: true,
      recordSpec: { kind: "notice", path: "/api/v1/appointment-notices/{id}", match: matchPathId("id", id) },
    };
  }
  if (segs[0] === "people" && segs[1] && segs[2] === "identifiers") {
    const id = safeDecode(segs[1]);
    return {
      title: t("shellRoutes.peopleIdentifiers"),
      isFallback: true,
      recordSpec: { kind: "identifiers", path: "/api/v1/employees/{id}", match: matchPathId("id", id) },
    };
  }
  if (segs[0] === "people" && segs[1] && !segs[2]) {
    const id = safeDecode(segs[1]);
    return {
      title: t("shellRoutes.peopleCard"),
      isFallback: true,
      recordSpec: { kind: "employee", path: "/api/v1/employees/{id}", match: matchPathId("id", id) },
    };
  }
  if (segs[0] === "payroll" && segs[1] === "runs" && segs[2] && segs[2] !== "new") {
    const id = safeDecode(segs[2]);
    return {
      title: t("shellRoutes.payrollRun"),
      isFallback: true,
      recordSpec: { kind: "payrollRun", path: "/api/v1/payroll/runs/{id}", match: matchPathId("id", id) },
    };
  }
  if (segs[0] === "payroll" && segs[1] === "employees" && segs[2]) {
    const id = safeDecode(segs[2]);
    return {
      title: t("shellRoutes.payrollEmployee"),
      isFallback: true,
      recordSpec: { kind: "employeePay", path: "/api/v1/employees/{id}", match: matchPathId("id", id) },
    };
  }
  if (segs[0] === "access" && segs[1] === "roles" && segs[2] && segs[2] !== "new") {
    const roleId = safeDecode(segs[2]);
    return {
      title: t("shellRoutes.accessRoleDetail"),
      isFallback: true,
      recordSpec: { kind: "accessRole", path: "/api/v1/access/roles/{roleId}/versions", match: matchPathId("roleId", roleId) },
    };
  }
  if (segs[0] === "access" && segs[1] === "people" && segs[2]) {
    const id = safeDecode(segs[2]);
    return {
      title: t("shellRoutes.accessPerson"),
      isFallback: true,
      recordSpec: { kind: "accessPerson", path: "/api/v1/access/people/{id}", match: matchPathId("id", id) },
    };
  }
  return null;
}

export function formatRecordTitle(spec: { kind: RecordKind; node?: string }, data: unknown, locale: string): string | null {
  if (!data || typeof data !== "object") return null;
  const { kind } = spec;
  if (kind === "accessRole" && Array.isArray(data)) {
    const latest = (data as Array<{ name_ko?: string | null; name_en?: string | null; version?: number }>)
      .reduce((best, cur) => (!best || (cur.version ?? 0) >= (best.version ?? 0) ? cur : best), undefined as { name_ko?: string | null; name_en?: string | null; version?: number } | undefined);
    const name = locale === "en" ? latest?.name_en || latest?.name_ko : latest?.name_ko || latest?.name_en;
    return name?.trim() || null;
  }
  const rec = data as Record<string, unknown>;
  switch (kind) {
    case "employee":
    case "identifiers":
    case "employeePay": {
      const emp = rec.employee as { name?: string | null; employee_number?: string | null } | undefined;
      const name = emp?.name?.trim();
      if (!name) return null;
      if (kind === "identifiers") return t("shellRoutes.identifiers", { name });
      if (kind === "employeePay") return t("shellRoutes.employeePay", { name });
      const num = emp?.employee_number?.trim();
      return num ? t("shellRoutes.pair", { primary: name, secondary: num }) : name;
    }
    case "exitCase": {
      const name = typeof rec.employee_name === "string" ? rec.employee_name.trim() : "";
      return name ? t("shellRoutes.exitCase", { name }) : null;
    }
    case "orgChange": {
      const code = typeof rec.code === "string" ? rec.code.trim() : "";
      return code ? t("shellRoutes.orgChange", { code }) : null;
    }
    case "approval": {
      const docNo = typeof rec.document_no === "string" ? rec.document_no.trim() : "";
      // The kind of document, not its long title, follows the number, so the tab reads whole.
      const source = rec.source as { label?: unknown } | undefined;
      const kindLabel = typeof source?.label === "string" ? source.label.trim() : "";
      const title = kindLabel || (typeof rec.title === "string" ? rec.title.trim() : "");
      if (docNo && title) return `${docNo} ${title}`;
      return docNo || title || null;
    }
    case "entity": {
      const current = rec.current as { display_name?: string | null; name?: string | null } | undefined;
      return current?.display_name?.trim() || current?.name?.trim() || null;
    }
    case "payrollRun": {
      const run = rec.run as { attribution_month?: string | null } | undefined;
      const month = monthOnly(run?.attribution_month?.trim());
      return month ? t("shellRoutes.payrollRunMonth", { month }) : null;
    }
    case "attendanceScope": {
      const nodes = Array.isArray(rec.nodes) ? (rec.nodes as Array<{ id?: unknown; name?: unknown }>) : [];
      const name = nodes.find(node => node.id === spec.node)?.name;
      return typeof name === "string" && name.trim() ? name.trim() : null;
    }
    case "certificate": {
      const no = typeof rec.certificate_no === "string" ? rec.certificate_no.trim() : "";
      const snap = rec.snapshot as { name?: string | null } | undefined;
      const name = snap?.name?.trim() || "";
      if (no && name) return t("shellRoutes.pair", { primary: no, secondary: name });
      return no || name || null;
    }
    case "notice": {
      const title = typeof rec.title === "string" ? rec.title.trim() : "";
      const no = typeof rec.notice_no === "string" ? rec.notice_no.trim() : "";
      return title || no || null;
    }
    case "accessPerson": {
      const empName = typeof rec.employee_name === "string" ? rec.employee_name.trim() : "";
      const dispName = typeof rec.display_name === "string" ? rec.display_name.trim() : "";
      return empName || dispName || null;
    }
    default:
      return null;
  }
}
