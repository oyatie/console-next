// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";
import type { PayGroups } from "@console/api/pending";
import { t } from "@console/i18n";
import raw from "./saeon-universe.json" with { type: "json" };
import {
  brnChecksumValid,
  crnChecksumValid,
  formatBrn,
  formatCrn,
  maskMobilePhone,
  maskRrn,
  padDigits,
  rrnChecksumValid,
  syntheticBrn,
  syntheticCrn,
  syntheticInvalidRrn,
} from "./saeon-ids";
import {
  buildSaeonRoster,
  type SaeonEmploymentTypeCode,
  type SaeonEntity,
  type SaeonGradeCode,
  type SaeonMissingCode,
  type SaeonRoleCode,
  type SaeonRosterRow,
} from "./saeon-roster";

export {
  brnChecksumValid,
  crnChecksumValid,
  formatBrn,
  formatCrn,
  maskMobilePhone,
  maskRrn,
  rrnChecksumValid,
  syntheticBrn,
  syntheticCrn,
  syntheticInvalidRrn,
};

type S = components["schemas"];

const SAEON_AT = "2026-11-10T09:00:00Z";
const BASE_PAY_BY_GRADE: Record<SaeonGradeCode, number> = {
  STAFF: 2_700_000,
  SENIOR_STAFF: 3_100_000,
  ASSISTANT_MANAGER: 3_600_000,
  MANAGER: 4_300_000,
  DEPUTY_GM: 5_000_000,
  GENERAL_MANAGER: 5_800_000,
};

const entities: readonly SaeonEntity[] = raw.entities.map((entity, entityIndex) => {
  const crn = syntheticCrn(entityIndex + 1);
  return {
    id: `00000000-0000-4000-8100-${padDigits(entityIndex + 1, 12)}`,
    prefix: entity.prefix,
    name: entity.name,
    headcount: entity.headcount,
    crn,
    crnFormatted: formatCrn(crn),
    workplaces: entity.workplaces.map((site, siteIndex) => {
      const headOffice = siteIndex === 0;
      const brn = syntheticBrn(entityIndex + 1, siteIndex, headOffice);
      return {
        id: `00000000-0000-4000-8200-${padDigits((entityIndex + 1) * 100 + siteIndex + 1, 12)}`,
        name: site.name,
        headOffice,
        brn,
        brnFormatted: formatBrn(brn),
        departments: site.departments,
      };
    }),
  };
});

const heroRrn = syntheticInvalidRrn(raw.hero.birthDate, raw.hero.genderDigit as 1, 587);
const heroMobile = `010-0000-${raw.hero.phoneLastFour}`;

export const saeonUniverse = {
  tenantName: raw.tenantName,
  referenceDate: raw.referenceDate,
  referenceDateDisplay: raw.referenceDateDisplay,
  adminActor: raw.adminActor,
  counts: raw.counts,
  grades: raw.grades,
  roles: raw.roles,
  employmentTypes: raw.employmentTypes,
  missingLabels: raw.missingLabels,
  entities,
  hero: {
    ...raw.hero,
    gradeCode: raw.hero.gradeCode as SaeonGradeCode,
    roleCode: raw.hero.roleCode as SaeonRoleCode,
    employmentTypeCode: raw.hero.employmentTypeCode as SaeonEmploymentTypeCode,
    entityName: entities[raw.hero.entityIndex]!.name,
    gradeLabel: raw.grades[raw.hero.gradeCode as SaeonGradeCode],
    roleLabel: raw.roles[raw.hero.roleCode as SaeonRoleCode],
    employmentTypeLabel: raw.employmentTypes[raw.hero.employmentTypeCode as SaeonEmploymentTypeCode],
    rrn: heroRrn,
    rrnMasked: maskRrn(heroRrn),
    mobilePhone: heroMobile,
    mobilePhoneMasked: maskMobilePhone(heroMobile),
  },
  rosterWindow: raw.rosterWindow.map(row => ({
    ...row,
    gradeCode: row.gradeCode as SaeonGradeCode,
    roleCode: row.roleCode as SaeonRoleCode | null,
    employmentTypeCode: row.employmentTypeCode as SaeonEmploymentTypeCode,
    missingCode: row.missingCode as SaeonMissingCode | null,
    entityName: entities[row.entityIndex]!.name,
    gradeLabel: raw.grades[row.gradeCode as SaeonGradeCode],
    roleLabel: row.roleCode ? raw.roles[row.roleCode as SaeonRoleCode] : "",
    employmentTypeLabel: raw.employmentTypes[row.employmentTypeCode as SaeonEmploymentTypeCode],
    missingLabel: row.missingCode ? raw.missingLabels[row.missingCode as SaeonMissingCode] : "",
  })),
  worklist: raw.worklist,
  approval: raw.approval,
  attendanceMonth: raw.attendanceMonth,
  payrollRun: {
    ...raw.payrollRun,
    entityName: entities[raw.payrollRun.entityIndex]!.name,
    windowRows: raw.payrollRun.windowRows.map(row => ({
      ...row,
      gradeCode: row.gradeCode as SaeonGradeCode,
      gradeLabel: raw.grades[row.gradeCode as SaeonGradeCode],
    })),
  },
} as const;

let cachedRoster: readonly SaeonRosterRow[] | null = null;

/** Deterministic 2,054-row active roster placing the 22 boarded rows at 1278..1299 and hero 10587 at 1287. */
export function generateSaeonRoster(): readonly SaeonRosterRow[] {
  cachedRoster ??= buildSaeonRoster(entities, saeonUniverse.hero);
  return cachedRoster;
}

export function saeonPayrollRow(
  employeeNumber: string,
  gradeCode: SaeonGradeCode,
  overtimeHours: number,
  bankAccountRegistered: boolean,
) {
  const basePay = BASE_PAY_BY_GRADE[gradeCode];
  const overtimePay = Math.round(((basePay / 209) * 1.5 * overtimeHours) / 100) * 100;
  const mealAllowance = 200_000;
  const grossPay = basePay + overtimePay + mealAllowance;
  const taxablePay = grossPay - mealAllowance;
  const nationalPension = Math.floor((taxablePay * 45) / 1000);
  const healthInsurance = Math.floor((taxablePay * 3545) / 100_000);
  const longTermCare = Math.floor((healthInsurance * 1295) / 10_000);
  const employmentInsurance = Math.floor((taxablePay * 9) / 1000);
  const incomeTax = Math.round((taxablePay * 29_326) / 10_000_000) * 10;
  const localIncomeTax = Math.floor(incomeTax / 100) * 10;
  const totalDeductions =
    nationalPension + healthInsurance + longTermCare + employmentInsurance + incomeTax + localIncomeTax;
  return {
    employeeNumber,
    overtimeHours,
    basePay,
    overtimePay,
    mealAllowance,
    grossPay,
    taxablePay,
    nationalPension,
    healthInsurance,
    longTermCare,
    employmentInsurance,
    incomeTax,
    localIncomeTax,
    totalDeductions,
    netPay: grossPay - totalDeductions,
    bankAccountRegistered,
  };
}

export function saeonAttendanceSummary() {
  const { scheduledWorkDays, weekdayHolidays, members } = raw.attendanceMonth;
  let totalWorkDays = 0;
  let totalLeaveDays = 0;
  let totalApprovedOvertimeHours = 0;
  let openExceptionCount = 0;

  for (const member of members) {
    const annual = member.annualLeaveDays.length;
    const half = member.halfLeaveDays.length * 0.5;
    const absent = member.absentDays.length;
    const holidayWork = member.holidayWorkDays.length;
    const memberWorkDays = scheduledWorkDays - annual - half - absent + holidayWork;
    const memberLeaveDays = annual + half;
    const approvedHours = Object.values(member.approvedOvertime).reduce((sum, hours) => sum + Number(hours), 0);
    const unapprovedDays = Object.keys(member.unapprovedOvertime).length;

    totalWorkDays += memberWorkDays;
    totalLeaveDays += memberLeaveDays;
    totalApprovedOvertimeHours += approvedHours;
    openExceptionCount += member.lateDays.length + member.absentDays.length + unapprovedDays;
  }

  return {
    memberCount: members.length,
    scheduledWorkDays,
    weekdayHolidays,
    totalWorkDays,
    totalLeaveDays,
    totalApprovedOvertimeHours,
    openExceptionCount,
    canCloseMonth: openExceptionCount === 0,
  };
}

/** OpenAPI-typed desk HR administrator profile for mock screen specs. */
export function saeonAdminUser(): S["CurrentUser"] {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    display_name: saeonUniverse.adminActor.name,
    employee_id: "00000000-0000-4000-8300-000000000001",
    employee_name: saeonUniverse.adminActor.name,
    employee_number: "10012",
    employee_company: saeonUniverse.entities[0]!.name,
    employee_org_unit: saeonUniverse.adminActor.unit,
    employee_position: saeonUniverse.adminActor.grade,
    employee_identity_review_required: false,
    employee_identity_resolution_confidence: "high",
    employee_link_status: "LINKED",
    phone: null,
    team: "MANAGEMENT",
    roles: [],
    branch_ids: [],
    is_active: true,
    is_tenant_ops: false,
    has_passkey: true,
    account_status: "ACTIVE",
    created_at: SAEON_AT,
    tenant: { name: saeonUniverse.tenantName, phase: "OPERATING", go_live_at: "2026-01-01T00:00:00Z" },
  };
}

/** OpenAPI-typed refresh token pair carrying the Saeon HR administrator claims. */
export function saeonAdminToken(orgId = "00000000-0000-4000-8000-000000000002"): S["TokenPairResponse"] {
  const admin = saeonAdminUser();
  const claims = {
    sub: admin.id,
    org: orgId,
    name: admin.display_name,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return {
    access_token: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.mock`,
    token_type: "Bearer",
    refresh_expires_at: "2099-01-01T00:00:00Z",
    requires_passkey_setup: false,
    privacy_consent_accepted: true,
  };
}

/** OpenAPI-typed self-service employee profile (employee 10587) for phone screen specs. */
export function saeonHeroUser(): S["CurrentUser"] {
  const heroRow = generateSaeonRoster()[1286]!;
  return {
    id: "00000000-0000-4000-8000-000000000587",
    display_name: saeonUniverse.hero.name,
    employee_id: heroRow.id,
    employee_name: saeonUniverse.hero.name,
    employee_number: saeonUniverse.hero.employeeNumber,
    employee_company: saeonUniverse.hero.entityName,
    employee_org_unit: heroRow.place.split(" › ").at(-1) ?? null,
    employee_position: `${saeonUniverse.hero.gradeLabel} · ${saeonUniverse.hero.roleLabel}`,
    employee_identity_review_required: false,
    employee_identity_resolution_confidence: "high",
    employee_link_status: "LINKED",
    phone: saeonUniverse.hero.mobilePhoneMasked,
    team: "MAINTENANCE",
    roles: [],
    branch_ids: [heroRow.workplaceId],
    is_active: true,
    is_tenant_ops: false,
    has_passkey: true,
    account_status: "ACTIVE",
    created_at: SAEON_AT,
    tenant: { name: saeonUniverse.tenantName, phase: "OPERATING", go_live_at: "2026-01-01T00:00:00Z" },
  };
}

/** OpenAPI-typed `OrgStructure` across all 5 legal entities and 40 workplaces. */
export function saeonOrgStructure(): S["OrgStructure"] {
  let deptSeq = 1;
  return {
    tenant_name: saeonUniverse.tenantName,
    phase: "OPERATING",
    unplaced: [],
    entities: saeonUniverse.entities.map(entity => ({
      id: entity.id,
      kind: "LEGAL_ENTITY" as const,
      name: entity.name,
      version: 1,
      headcount: entity.headcount,
      direct_headcount: 0,
      dispatched_headcount: 0,
      chips: [],
      children: entity.workplaces.map((site, siteIdx) => {
        const siteHeadcount = siteIdx === 0
          ? entity.headcount - Math.floor(entity.headcount * 0.6)
          : Math.max(1, Math.floor((entity.headcount * 0.6) / Math.max(1, entity.workplaces.length - 1)));
        return {
          id: site.id,
          kind: "WORKPLACE" as const,
          name: site.name,
          version: 1,
          headcount: siteHeadcount,
          direct_headcount: site.departments.length === 0 ? siteHeadcount : 0,
          dispatched_headcount: 0,
          chips: [],
          children: site.departments.map(deptName => ({
            id: `00000000-0000-4000-8400-${padDigits(deptSeq++, 12)}`,
            kind: "DEPARTMENT" as const,
            name: deptName,
            version: 1,
            headcount: Math.max(1, Math.floor(siteHeadcount / site.departments.length)),
            direct_headcount: Math.max(1, Math.floor(siteHeadcount / site.departments.length)),
            dispatched_headcount: 0,
            chips: [],
            children: [],
          })),
        };
      }),
    })),
  };
}

/** OpenAPI-typed `EmployeeFacets` matching the boarded roster tiles and facets. */
export function saeonEmployeeFacets(): S["EmployeeFacets"] {
  const { counts } = saeonUniverse;
  return {
    total: counts.active,
    status: [
      { value: "ACTIVE", count: counts.active },
      { value: "LEAVE", count: counts.leave },
      { value: "PRE_HIRE", count: counts.joining },
      { value: "EXITED", count: counts.exited },
    ],
    employment_type: [
      { value: "REGULAR", count: 1812 },
      { value: "CONTRACT", count: 196 },
      { value: "PART_TIME", count: 46 },
    ],
    legal_entity: saeonUniverse.entities.map(entity => ({
      value: entity.id,
      count: entity.headcount,
    })),
    workplace: saeonUniverse.entities.flatMap(entity =>
      entity.workplaces.map(site => ({
        value: site.id,
        count: Math.max(1, Math.floor(entity.headcount / entity.workplaces.length)),
      })),
    ),
    review: {
      identity_review_required: 0,
      register_review_required: counts.missingInfo,
      home_branch_review_required: 0,
      lifecycle_apply_failed: 0,
      contract_ended: 0,
      contract_ending_before: counts.contractEndingSoon,
    },
  };
}

/** OpenAPI-typed slice of `Employee` records from the deterministic 2,054-row roster. */
export function saeonRosterEmployees(offset = 1277, limit = 22): S["Employee"][] {
  return generateSaeonRoster()
    .slice(offset, offset + limit)
    .map(row => ({
      id: row.id,
      company: row.entityName,
      name: row.name,
      employee_number: row.employeeNumber,
      org_unit_id: null,
      legal_entity_id: row.entityId,
      workplace_id: row.workplaceId,
      org_unit: row.place,
      position: row.roleLabel ? `${row.gradeLabel} · ${row.roleLabel}` : row.gradeLabel,
      status: "ACTIVE",
      hire_date: row.hireDate,
      employment_type: row.employmentTypeCode,
      home_branch_review_required: false,
      identity_resolution_strategy: "employee_number",
      identity_resolution_confidence: "high",
      identity_review_required: false,
      identity_name_only_merge: false,
      next_event: null,
      failed_event: null,
      created_at: SAEON_AT,
      updated_at: SAEON_AT,
    }));
}

const SAEON_ORG_CHANGE_ID = "00000000-0000-4000-8600-000000000418";

function kstDaysBetween(fromIso: string, toIso: string): number {
  const fromMs = Date.parse(`${fromIso}T00:00:00+09:00`);
  const toMs = Date.parse(`${toIso}T00:00:00+09:00`);
  return Math.round((toMs - fromMs) / 86_400_000);
}

/** OpenAPI-typed `ActionInboxResponse` matching the boarded 10-row Saeon Console worklist. */
export function saeonWorklistInbox(): S["ActionInboxResponse"] & {
  attention_filters: { key: "all" | "approvals" | "today" | "overdue"; total: number; total_is_exact: boolean }[];
} {
  const { worklist, referenceDate, approval } = saeonUniverse;
  const orgUnits = saeonOrgStructure().entities[0]?.children?.[0]?.children ?? [];
  const items: S["ActionInboxItem"][] = worklist.items.map((row, index) => {
    const daysRemaining = row.dueDate ? kstDaysBetween(referenceDate, row.dueDate) : null;
    const dueTone: S["ActionInboxItem"]["dueTone"] =
      daysRemaining != null && daysRemaining < 0
        ? "danger"
        : daysRemaining === 0 || row.kind === "approval"
          ? "warn"
          : "neutral";
    const isPrimaryApproval = row.id === approval.documentNumber;
    const isSecondaryApproval = row.kind === "approval" && !isPrimaryApproval;
    const isAttendanceClose = row.id === "att-close-1";
    const kind =
      isPrimaryApproval
        ? "org_change_approve"
        : isSecondaryApproval
          ? "approval"
          : isAttendanceClose
            ? "period_unlock"
            : row.statutory && row.id.startsWith("ins-")
              ? "insurance_filing"
              : row.statutory && row.id.startsWith("exit-")
                ? "hr_exit_settle"
                : row.id.startsWith("exit-")
                  ? "hr_exit_confirm"
                  : row.id.startsWith("probation-")
                    ? "contract_renewal"
                    : row.id.startsWith("missing-")
                      ? "register_review"
                      : "hr_request";
    const linkKind =
      isPrimaryApproval
        ? "org_change"
        : isSecondaryApproval
          ? "approval_run"
          : isAttendanceClose
            ? "period_lock"
            : kind === "insurance_filing"
              ? "statutory"
              : kind.startsWith("hr_exit")
                ? "exit_case"
                : kind === "contract_renewal" || kind === "register_review"
                  ? "employee"
                  : "change_request";
    const linkId = isPrimaryApproval
      ? SAEON_ORG_CHANGE_ID
      : `00000000-0000-4000-8600-${padDigits(index + 1, 12)}`;

    return {
      id: row.id,
      kind,
      urg: daysRemaining != null && daysRemaining < 0 ? "now" : daysRemaining === 0 ? "today" : "wait",
      ref: isPrimaryApproval ? approval.documentNumber : "",
      title: row.title,
      site: row.subject,
      who: isPrimaryApproval ? approval.steps[0]?.actor : undefined,
      due: row.dueDate ? `${row.dueDate}T09:00:00+09:00` : undefined,
      due_basis: row.statutory ? "statutory" : undefined,
      dueTone,
      links: [{ kind: linkKind, id: linkId }],
      done: false,
      lane: "turn",
      days_remaining: daysRemaining,
      can_decide: isPrimaryApproval || isSecondaryApproval ? true : undefined,
      snooze: row.kind === "approval" ? { allowed: false, reason: "blocks_others" } : { allowed: true },
      context: {
        ...(isPrimaryApproval
          ? {
              command: "approve" as const,
              drafter: approval.steps[0]?.actor,
              reason: row.reason,
            }
          : { reason: row.reason }),
        ...(isAttendanceClose ? { worksite_name: saeonUniverse.entities[0]!.workplaces[1]!.name } : {}),
        ...(kind === "register_review"
          ? {
              register: { missing_fields: ["address"] },
              review_count: saeonUniverse.counts.missingAddress,
            }
          : {}),
        ...(row.id.startsWith("probation-") ? { review_count: saeonUniverse.counts.probationEnding } : {}),
        ...(orgUnits[0] && isPrimaryApproval ? { worksite_name: undefined } : {}),
      },
    };
  });

  items.push({
    id: "payroll-oct-1",
    kind: "payroll",
    urg: "wait",
    ref: "",
    title: `${saeonUniverse.payrollRun.yearMonth} ${t("accessCodes.domain.pay")}`,
    site: `${saeonUniverse.payrollRun.entityName} · ${t("home.worklist.personCount", { count: saeonUniverse.payrollRun.headcount })}`,
    due: undefined,
    dueTone: "neutral",
    links: [{ kind: "pay_run", id: "00000000-0000-4000-8600-000000000011" }],
    done: false,
    lane: "turn",
    days_remaining: null,
    snooze: { allowed: true },
    context: {
      reason: `${t("payroll.create.payDate")} ${saeonUniverse.payrollRun.payDate.slice(5)} · ${t("accessCodes.domain.bank")} ${t("person.field.notSet")} ${t("home.worklist.personCount", { count: saeonUniverse.payrollRun.missingBankAccountCount })}`,
    },
  });

  return {
    items,
    total: worklist.totalCount,
    total_is_exact: true,
    next_cursor: null,
    unavailable: [],
    counts: {
      turn: { total: worklist.totalCount, total_is_exact: true },
      waiting: { total: 4, total_is_exact: true },
      scheduled: { total: 2, total_is_exact: true },
      failures: { total: 0, total_is_exact: true },
    },
    attention_filters: [
      { key: "all", total: worklist.totalCount, total_is_exact: true },
      { key: "approvals", total: worklist.approvalCount, total_is_exact: true },
      { key: "today", total: worklist.todayCount, total_is_exact: true },
      { key: "overdue", total: worklist.overdueCount, total_is_exact: true },
    ],
    upcoming: [],
    snooze_presets: [
      { key: "short", date: "2026-11-11" },
      { key: "next_week", date: "2026-11-16" },
      { key: "long", date: "2026-11-24" },
    ],
    has_work: true,
    quick_starts: [],
    as_of: `${referenceDate}T00:00:00Z`,
    available_filters: ["turn", "waiting", "scheduled", "deadlines", "failures"],
  };
}

/** OpenAPI-typed `OrgChangeDetail` for boarded approval document `OC-2026-0418`. */
export function saeonApprovalOrgChange(): S["OrgChangeDetail"] {
  const { approval } = saeonUniverse;
  const roleKeys: S["OrgChangeApprovalRoleKey"][] = ["executive", "hr", "executive"];
  return {
    id: SAEON_ORG_CHANGE_ID,
    code: approval.documentNumber,
    kind: "REORG",
    status: "IN_APPROVAL",
    target: {
      kind: "ORG_UNIT",
      ref: "00000000-0000-4000-8400-000000000002",
      label: approval.title,
    },
    effectiveDate: approval.effectiveDate,
    reason: approval.reason,
    headcount: approval.transferredCount,
    siteCount: 1,
    teamCount: 2,
    draftedBy: "00000000-0000-4000-8000-000000000002",
    draftedByName: approval.steps[0] ? `${approval.steps[0].actor} · ${approval.steps[0].unit}` : null,
    createdAt: `${approval.draftedDate}T09:00:00+09:00`,
    updatedAt: SAEON_AT,
    proposal: [
      {
        op: "REASSIGN_ORG_UNIT",
        fromOrgUnit: "00000000-0000-4000-8400-000000000003",
        toOrgUnit: "00000000-0000-4000-8400-000000000002",
        scope: { company: "00000000-0000-4000-8200-000000000001" },
      },
      {
        op: "DISSOLVE_ORG_UNIT",
        orgUnitId: "00000000-0000-4000-8400-000000000003",
        mergedInto: "00000000-0000-4000-8400-000000000002",
      },
    ],
    preflight: {
      computedAt: SAEON_AT,
      stale: false,
      blockers: [],
      warnings: [],
      headcount: approval.afterHeadcount,
      dependentsTotal: 1,
    },
    approvalSteps: approval.steps.map((step, index) => ({
      id: `00000000-0000-4000-8700-${padDigits(index + 1, 12)}`,
      stepOrder: step.step,
      roleKey: roleKeys[index] ?? "hr",
      decision: step.status === "DONE" ? "APPROVED" : "PENDING",
      decidedByName: `${step.actor} · ${step.unit}`,
      decidedAt: step.completedDate ? `${step.completedDate}T09:00:00+09:00` : undefined,
    })),
    settlementItems: [],
    events: [],
  };
}

const SAEON_PAYROLL_RUN_ID = "00000000-0000-4000-8600-000000000011";

/** OpenAPI-typed `PayGroups` across all five Saeon legal entities. */
export function saeonPayGroups(): PayGroups {
  return {
    legal_entities: saeonUniverse.entities.map(entity => ({ id: entity.id, name: entity.name })),
    items: saeonUniverse.entities.map((entity, index) => ({
      id: `00000000-0000-4000-8500-${padDigits(index + 1, 12)}`,
      legal_entity_id: entity.id,
      name: `${entity.prefix} ${t("payroll.group")}`,
      pay_date_rule: { day: 25 as const, month_offset: 1 as const, non_business_day: "PREVIOUS" as const },
      base_period: { start_day: "FIRST" as const, month_offset: 0 as const },
      variable_period: { start_day: 16 as const, month_offset: -1 as const },
      proration: "CALENDAR_DAYS" as const,
      channel: "FILE_GENERIC" as const,
      sensitive: false,
      pay_basis_allowed: ["MONTHLY" as const],
    })),
  };
}

function toLineSummary(
  lineId: string,
  employeeId: string,
  displayName: string,
  company: string,
  calc: ReturnType<typeof saeonPayrollRow>,
): S["PayrollLineSummary"] {
  return {
    id: lineId,
    employee_id: employeeId,
    employee_display_name: displayName,
    employee_company: company,
    work_days: 22,
    overtime_hours: calc.overtimeHours,
    leave_used: 0,
    gross_pay_source_present: true,
    net_pay_source_present: calc.bankAccountRegistered,
    nts_tax_row_status: "VERIFIED_SOURCE_ROW",
    calculation_status: calc.bankAccountRegistered ? "READY_FOR_REVIEW" : "BLOCKED_LEGAL_GATE",
    blockers: calc.bankAccountRegistered ? [] : ["ACCOUNT_VERIFICATION"],
    gross_won: calc.grossPay,
    deductions: [
      { code: "NATIONAL_PENSION", label_ko: t("enum.insurer.NPS"), amount_won: calc.nationalPension, source_url: "https://www.nps.or.kr" },
      { code: "HEALTH_INSURANCE", label_ko: t("enum.insurer.NHIS"), amount_won: calc.healthInsurance, source_url: "https://www.nhis.or.kr" },
      { code: "LONG_TERM_CARE", label_ko: t("payroll.run.col.longTermCare"), amount_won: calc.longTermCare, source_url: "https://www.nhis.or.kr" },
      { code: "EMPLOYMENT_INSURANCE", label_ko: t("enum.insurer.EI"), amount_won: calc.employmentInsurance, source_url: "https://www.ei.go.kr" },
      { code: "INCOME_TAX", label_ko: t("payroll.run.col.incomeTax"), amount_won: calc.incomeTax, source_url: "https://www.nts.go.kr" },
      { code: "LOCAL_INCOME_TAX", label_ko: t("payroll.run.col.localIncomeTax"), amount_won: calc.localIncomeTax, source_url: "https://www.nts.go.kr" },
    ],
    total_deductions_won: calc.totalDeductions,
    net_won: calc.netPay,
    tax_table_version: saeonUniverse.payrollRun.yearMonth,
  };
}

/** OpenAPI-typed `PayrollRunDetail` matching the boarded 2026-10 Saeon payroll run and window rows. */
export function saeonPayrollRunDetail(options: { offset?: number; limit?: number } = {}): S["PayrollRunDetail"] {
  const { payrollRun } = saeonUniverse;
  const entity = saeonUniverse.entities[payrollRun.entityIndex]!;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? 50);
  const roster = generateSaeonRoster();
  const rosterByNumber = new Map(roster.map(row => [row.employeeNumber, row]));

  const lines: S["PayrollLineSummary"][] =
    offset === 0
      ? payrollRun.windowRows.map((row, index) => {
          const calc = saeonPayrollRow(row.employeeNumber, row.gradeCode, row.overtimeHours, row.bankAccountRegistered);
          const employeeId = rosterByNumber.get(row.employeeNumber)?.id ?? `00000000-0000-4000-8300-${padDigits(index + 1, 12)}`;
          return toLineSummary(`00000000-0000-4000-8800-${padDigits(index + 1, 12)}`, employeeId, row.name, entity.name, calc);
        })
      : roster.slice(offset, Math.min(payrollRun.headcount, offset + limit)).map((row, index) => {
          const calc = saeonPayrollRow(row.employeeNumber, row.gradeCode, index % 4 === 0 ? 4 : 0, true);
          return toLineSummary(`00000000-0000-4000-8800-${padDigits(offset + index + 1, 12)}`, row.id, row.name, entity.name, calc);
        });

  return {
    run: {
      id: SAEON_PAYROLL_RUN_ID,
      legal_entity_id: entity.id,
      pay_group_id: "00000000-0000-4000-8500-000000000001",
      kind: "REGULAR",
      attribution_month: payrollRun.yearMonth,
      pay_date: payrollRun.payDate,
      period_start: "2026-10-01",
      period_end: "2026-10-31",
      variable_period_start: "2026-09-16",
      variable_period_end: "2026-10-15",
      source_label: `${payrollRun.yearMonth} ${t("payroll.title")}`,
      status: "CALCULATED",
      calculation_enabled: true,
      created_at: SAEON_AT,
      updated_at: SAEON_AT,
    },
    legal_basis: {},
    source_summary: {},
    lines,
    lines_total: payrollRun.headcount,
    lines_limit: limit,
    lines_offset: offset,
    exceptions_open: payrollRun.missingBankAccountCount,
    exceptions_total: payrollRun.missingBankAccountCount,
    calculation: {
      version: 1,
      calculated_at: SAEON_AT,
      calculated_lines: payrollRun.headcount - payrollRun.missingBankAccountCount,
      blocked_lines: payrollRun.missingBankAccountCount,
      payable: false,
      kernel_rate_table: "2026-KR",
      total_gross_won: payrollRun.grossTotal,
      total_deductions_won: payrollRun.deductionTotal,
      total_net_won: payrollRun.netTotal,
    },
    disbursement: null,
    payslip_delivery: null,
  };
}

/** OpenAPI-typed `Employee[]` matching every row in `saeonUniverse.payrollRun.windowRows`. */
export function saeonPayrollEmployees(): S["Employee"][] {
  const { payrollRun } = saeonUniverse;
  const entity = saeonUniverse.entities[payrollRun.entityIndex]!;
  const rosterByNumber = new Map(generateSaeonRoster().map(row => [row.employeeNumber, row]));

  return payrollRun.windowRows.map((row, index) => {
    const match = rosterByNumber.get(row.employeeNumber);
    const siteName = row.place.split(" \u203A ")[0]!;
    const site = entity.workplaces.find(w => w.name === siteName) ?? entity.workplaces[0]!;
    return {
      id: match?.id ?? `00000000-0000-4000-8300-${padDigits(index + 1, 12)}`,
      company: entity.name,
      name: row.name,
      employee_number: row.employeeNumber,
      org_unit_id: null,
      legal_entity_id: entity.id,
      workplace_id: site.id,
      org_unit: row.place,
      position: match?.roleLabel ? `${row.gradeLabel} \u00B7 ${match.roleLabel}` : row.gradeLabel,
      status: "ACTIVE",
      hire_date: match?.hireDate ?? "2020-01-01",
      employment_type: match?.employmentTypeCode ?? "REGULAR",
      home_branch_review_required: false,
      identity_resolution_strategy: "employee_number",
      identity_resolution_confidence: "high",
      identity_review_required: false,
      identity_name_only_merge: false,
      next_event: null,
      failed_event: null,
      created_at: SAEON_AT,
      updated_at: SAEON_AT,
    };
  });
}

/** OpenAPI-typed `PayrollRates` matching the statutory rates used by `saeonPayrollRow()`. */
export function saeonPayrollRates(): S["PayrollRates"] {
  const baseCitation = {
    effective_from: "2026-01-01",
    effective_to_exclusive: "2027-01-01",
    floor_won: null,
    cap_won: null,
    instrument_ko: t("payroll.reference.title"),
    article_ko: "Art. 1",
    promulgation_ko: "No. 1",
    enforced_on: "2026-01-01",
    retrieved_on: "2026-10-29",
    provenance_ko: t("payroll.reference.ACTIVE"),
    status: "ACTIVE" as const,
  };
  return {
    country_code: "KR",
    adopted: true,
    items: [
      {
        ...baseCitation,
        code: "NATIONAL_PENSION_EMPLOYEE",
        name: t("enum.insurer.NPS"),
        value: "45/1000",
        rate_num: 45,
        rate_den: 1000,
        basis: "PENSION_STANDARD_INCOME",
        bearer: "EMPLOYEE_WHOLE",
        source_url: "https://www.nps.or.kr",
      },
      {
        ...baseCitation,
        code: "HEALTH_INSURANCE_TOTAL",
        name: t("enum.insurer.NHIS"),
        value: "7090/100000",
        rate_num: 7090,
        rate_den: 100_000,
        basis: "MONTHLY_REMUNERATION",
        bearer: "HALF_EACH",
        source_url: "https://www.nhis.or.kr",
      },
      {
        ...baseCitation,
        code: "LONG_TERM_CARE_TOTAL",
        name: t("payroll.run.col.longTermCare"),
        value: "1295/10000",
        rate_num: 1295,
        rate_den: 10_000,
        basis: "HEALTH_INSURANCE_PREMIUM",
        bearer: "HALF_EACH",
        source_url: "https://www.nhis.or.kr",
      },
      {
        ...baseCitation,
        code: "EMPLOYMENT_INSURANCE_EMPLOYEE",
        name: t("enum.insurer.EI"),
        value: "9/1000",
        rate_num: 9,
        rate_den: 1000,
        basis: "MONTHLY_REMUNERATION",
        bearer: "EMPLOYEE_WHOLE",
        source_url: "https://www.ei.go.kr",
      },
      {
        ...baseCitation,
        code: "SIMPLIFIED_WITHHOLDING_TABLE",
        name: t("payroll.run.rateNote.simplifiedTax"),
        value: null,
        rate_num: null,
        rate_den: null,
        basis: "NOT_APPLICABLE",
        bearer: "NOT_APPLICABLE",
        source_url: "https://www.nts.go.kr",
      },
    ],
  };
}
