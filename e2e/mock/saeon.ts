// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
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
  heroDetails: raw.heroDetails,
  statusSamples: raw.statusSamples,
  reasonCodes: raw.reasonCodes,
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
    employee_grade: saeonUniverse.hero.gradeLabel,
    employee_hire_date: saeonUniverse.hero.hireDate,
    employee_employment_status: "ACTIVE",
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

/** OpenAPI-typed `MeProfileResponse` for the Saeon self-service hero employee (10587). */
export function saeonHeroProfile(overrides?: Partial<S["MeProfileResponse"]>): S["MeProfileResponse"] {
  const hero = saeonHeroUser();
  return {
    employee_id: hero.employee_id!,
    employee_number: hero.employee_number ?? null,
    org_unit: hero.employee_org_unit ?? null,
    grade: hero.employee_grade ?? null,
    position: hero.employee_position ?? null,
    hire_date: hero.employee_hire_date ?? null,
    employment_status: "ACTIVE",
    phone_masked: saeonUniverse.hero.mobilePhoneMasked,
    emergency_contacts_registered: true,
    emergency_contacts_count: 1,
    emergency_contacts: [
      {
        name: saeonUniverse.heroDetails.emergencyContactName,
        relation: "SPOUSE",
        phone_masked: "010-••••-9012",
      },
    ],
    address_masked: saeonUniverse.hero.address,
    bank_account_registered: true,
    open_change_requests: [
      {
        id: "00000000-0000-4000-8800-000000000401",
        field: "address",
        status: "OPEN",
        masked_summary: saeonUniverse.hero.address,
        created_at: "2026-11-02T01:00:00Z",
      },
    ],
    ...overrides,
  };
}

/** OpenAPI-typed self-service `Certificate` fixtures for Saeon hero employee (10587). */
export function saeonHeroCertificates(): S["Certificate"][] {
  const hero = saeonHeroUser();
  return saeonUniverse.heroDetails.certificates.map((cert, index) => ({
    id: `00000000-0000-4000-8850-${padDigits(index + 1, 12)}`,
    employee_id: hero.employee_id!,
    certificate_no: cert.certificateNo,
    kind: cert.kind as S["Certificate"]["kind"],
    items: ["period", "position"],
    purpose: cert.purpose,
    snapshot: {
      name: hero.employee_name!,
      birth: saeonUniverse.hero.birthDate,
      period: { from: saeonUniverse.hero.hireDate, to: saeonUniverse.referenceDate },
      duty: hero.employee_org_unit ?? undefined,
      position: hero.employee_position ?? undefined,
      wage: undefined,
      issuer: saeonUniverse.hero.entityName,
      seal_text: saeonUniverse.hero.entityName,
      seal_png: null,
    },
    replaces_id: null,
    issued_by: hero.id,
    issued_at: cert.issuedAt,
    voided_at: null,
    void_reason: null,
  }));
}

/** OpenAPI-typed refresh token pair carrying the Saeon self-service employee claims. */
export function saeonHeroToken(orgId = "00000000-0000-4000-8000-000000000002"): S["TokenPairResponse"] {
  const hero = saeonHeroUser();
  const claims = {
    sub: hero.id,
    org: orgId,
    name: hero.display_name,
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

function defaultHeroLeaveRequests(hero: S["CurrentUser"]): S["LeaveRequestV2View"][] {
  return [
    {
      id: "00000000-0000-4000-8800-000000000101",
      branch_id: hero.branch_ids[0]!,
      requester_user_id: hero.id,
      subject_employee_id: hero.employee_id!,
      leave_type: "half_day",
      days: 0.5,
      charge_units: "0.500000",
      charge_state: "resolved",
      charge_review_reasons: [],
      request_version: 1,
      charge_version: 1,
      partial_day_period: "am",
      start_date: "2026-11-06",
      end_date: "2026-11-06",
      status: "approved",
      decided_by: "00000000-0000-4000-8000-000000000010",
      decided_at: "2026-11-05T14:20:00+09:00",
      created_at: "2026-11-04T09:15:00+09:00",
    },
    {
      id: "00000000-0000-4000-8800-000000000102",
      branch_id: hero.branch_ids[0]!,
      requester_user_id: hero.id,
      subject_employee_id: hero.employee_id!,
      leave_type: "annual",
      days: 1,
      charge_units: "1.000000",
      charge_state: "resolved",
      charge_review_reasons: [],
      request_version: 1,
      charge_version: 1,
      start_date: "2026-10-23",
      end_date: "2026-10-23",
      status: "approved",
      decided_by: "00000000-0000-4000-8000-000000000010",
      decided_at: "2026-10-20T10:15:00+09:00",
      created_at: "2026-10-19T13:40:00+09:00",
    },
    {
      id: "00000000-0000-4000-8800-000000000103",
      branch_id: hero.branch_ids[0]!,
      requester_user_id: hero.id,
      subject_employee_id: hero.employee_id!,
      leave_type: "annual",
      days: 1,
      charge_units: "1.000000",
      charge_state: "resolved",
      charge_review_reasons: [],
      request_version: 1,
      charge_version: 1,
      start_date: "2026-10-08",
      end_date: "2026-10-08",
      status: "approved",
      decided_by: "00000000-0000-4000-8000-000000000010",
      decided_at: "2026-10-05T11:30:00+09:00",
      created_at: "2026-10-02T16:10:00+09:00",
    },
  ];
}

/** OpenAPI-typed `MyLeaveV2Overview` matching the Saeon self-service employee's leave balance. */
export function saeonMyLeaveOverview(overrides?: {
  filingState?: S["SelfLeaveBalance"]["filing_state"];
  homeBranchId?: string | null;
  accruedDays?: number | null;
  usedDays?: number | null;
  remainingDays?: number | null;
  items?: S["LeaveRequestV2View"][];
}): S["MyLeaveV2Overview"] {
  const hero = saeonHeroUser();
  const { leave } = saeonUniverse.hero;
  const filingState = overrides?.filingState ?? "ready";
  const accrued = overrides && "accruedDays" in overrides ? overrides.accruedDays : leave.grantedDays;
  const used = overrides && "usedDays" in overrides ? overrides.usedDays : leave.usedDays;
  const remaining = overrides && "remainingDays" in overrides ? overrides.remainingDays : leave.remainingDays;
  const toUnits = (v: number | null | undefined) => (v == null ? null : v.toFixed(6));
  return {
    balance: {
      employee_id: hero.employee_id!,
      name: hero.employee_name!,
      org_unit: hero.employee_org_unit ?? null,
      accrued_units: toUnits(accrued),
      used_units: toUnits(used),
      remaining_units: toUnits(remaining),
      filing_state: filingState,
      home_branch_id:
        filingState === "home_branch_required"
          ? null
          : overrides && "homeBranchId" in overrides
            ? overrides.homeBranchId ?? null
            : hero.branch_ids[0]!,
    },
    requests: {
      items: overrides?.items ?? defaultHeroLeaveRequests(hero),
      next_cursor: null,
    },
  };
}

/** OpenAPI-typed `SelfLeaveTeamOverlap` fixture for the Saeon hero's team. */
export function saeonMyLeaveTeamOverlap(overrides?: Partial<S["SelfLeaveTeamOverlap"]>): S["SelfLeaveTeamOverlap"] {
  const hero = saeonHeroUser();
  const teammate = saeonUniverse.attendanceMonth.members[7]!;
  return {
    org_unit: hero.employee_org_unit ?? null,
    active_count: saeonUniverse.attendanceMonth.members.length,
    out_count: 1,
    members_out: [
      {
        employee_id: `00000000-0000-4000-8500-${padDigits(Number(teammate.employeeNumber), 12)}`,
        name: teammate.name,
      },
    ],
    ...overrides,
  };
}

/** OpenAPI-typed `SelfLeaveApprovalPreview` fixture for the Saeon hero employee. */
export function saeonMyLeaveApprovalPreview(
  overrides?: Partial<S["SelfLeaveApprovalPreview"]>,
): S["SelfLeaveApprovalPreview"] {
  const hero = saeonHeroUser();
  const lead = saeonUniverse.attendanceMonth.members[0]!;
  return {
    filing_state: "ready",
    home_branch_id: hero.branch_ids[0]!,
    branch_name: saeonUniverse.hero.workplace,
    org_unit: hero.employee_org_unit ?? null,
    steps: [
      {
        order: 1,
        step_kind: "unit_lead",
        role_label: "TEAM_LEAD",
        approver_name: lead.name,
        approver_position: saeonUniverse.roles.TEAM_LEAD,
      },
      {
        order: 2,
        step_kind: "branch_hr",
        role_label: `${saeonUniverse.hero.workplace} Approver`,
        approver_name: null,
        approver_position: null,
      },
    ],
    ...overrides,
  };
}

/** OpenAPI-typed `LeaveRequestV2View` returned when filing a synthetic leave request. */
export function saeonLeaveRequestView(body: S["LeaveCreateRequest"], seq = 1): S["LeaveRequestV2View"] {
  const hero = saeonHeroUser();
  const days =
    body.leave_type === "half_day"
      ? 0.5
      : Math.max(1, Math.round((Date.parse(`${body.end_date}T00:00:00Z`) - Date.parse(`${body.start_date}T00:00:00Z`)) / 86_400_000) + 1);
  return {
    id: `00000000-0000-4000-8800-${padDigits(seq, 12)}`,
    branch_id: hero.branch_ids[0]!,
    requester_user_id: hero.id,
    subject_employee_id: hero.employee_id!,
    leave_type: body.leave_type,
    days,
    charge_units: null,
    charge_state: "review_required",
    charge_review_reasons: [],
    request_version: 1,
    charge_version: 1,
    ...(body.partial_day_period ? { partial_day_period: body.partial_day_period } : {}),
    start_date: body.start_date,
    end_date: body.end_date,
    status: "pending",
    decided_by: null,
    decided_at: null,
    created_at: `${saeonUniverse.hero.leave.draftDate}T09:00:00Z`,
  };
}

/** OpenAPI-typed `AttendanceScheduleCalendar` for the hero's production crew in a `YYYY-MM` month. */
export function saeonHeroScheduleMonth(month = "2026-11"): S["AttendanceScheduleCalendar"] {
  const hero = saeonHeroUser();
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const dayCount = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const days: S["AttendanceScheduleDay"][] = Array.from({ length: dayCount }, (_, i) => {
    const dayNum = i + 1;
    const iso = `${month}-${String(dayNum).padStart(2, "0")}`;
    const dow = new Date(Date.UTC(year, mon - 1, dayNum)).getUTCDay();
    return {
      date: iso,
      kind: dow === 0 || dow === 6 ? "WEEKLY_HOLIDAY" : "WORK",
    };
  });
  return {
    scope_kind: "WORKPLACE",
    scope_id: hero.branch_ids[0]!,
    scope_name: saeonUniverse.hero.shortPlace,
    month,
    stack: [],
    upcoming: [],
    days,
    holidays_loaded: true,
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
      { value: "ON_LEAVE", count: counts.leave },
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

function rowToEmployee(
  row: SaeonRosterRow,
  overrides: Partial<S["Employee"]> = {},
): S["Employee"] & { missing_code?: SaeonMissingCode | null } {
  const unplaced = row.place === "";
  return {
    id: row.id,
    person_id: row.id,
    company: row.entityName,
    name: row.name,
    employee_number: row.employeeNumber,
    org_unit_id: null,
    legal_entity_id: row.entityId,
    workplace_id: unplaced ? null : row.workplaceId,
    org_unit: unplaced ? null : row.place,
    position: row.roleLabel ? `${row.gradeLabel} · ${row.roleLabel}` : row.gradeLabel,
    status: "ACTIVE",
    hire_date: row.hireDate,
    employment_type: row.employmentTypeCode,
    register_review_required: Boolean(row.missingCode),
    home_branch_review_required: unplaced,
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    next_event: null,
    failed_event: null,
    created_at: SAEON_AT,
    updated_at: SAEON_AT,
    missing_code: row.missingCode,
    ...overrides,
  };
}

/** OpenAPI-typed slice of `Employee` records from the deterministic 2,054-row roster. */
export function saeonRosterEmployees(offset = 1277, limit = 22): S["Employee"][] {
  return generateSaeonRoster()
    .slice(offset, offset + limit)
    .map(row => rowToEmployee(row));
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

export const SAEON_HERO_ID = "00000000-0000-4000-8300-000000001287";
export const SAEON_EXITED_ID = "00000000-0000-4000-8300-000000009003";
const SAEON_ON_LEAVE_ID = "00000000-0000-4000-8300-000000009001";
const SAEON_PRE_HIRE_ID = "00000000-0000-4000-8300-000000009002";

function saeonStatusSampleEmployees(): Record<"onLeave" | "preHire" | "exited", S["Employee"]> {
  const make = (
    sample: {
      seq: number;
      name: string;
      employeeNumber: string;
      entityIndex: number;
      place: string;
      gradeCode: string;
      roleCode: string | null;
      employmentTypeCode: string;
      hireDate: string;
      statusSince?: string;
      expectedReturnDate?: string;
      exitDate?: string;
    },
    status: "ON_LEAVE" | "PRE_HIRE" | "EXITED",
  ): S["Employee"] => {
    const entity = entities[sample.entityIndex]!;
    const siteName = sample.place.split(" › ")[0]!;
    const site = entity.workplaces.find(w => w.name === siteName) ?? entity.workplaces[0]!;
    const gradeLabel = raw.grades[sample.gradeCode as SaeonGradeCode];
    const roleLabel = sample.roleCode ? raw.roles[sample.roleCode as SaeonRoleCode] : "";
    return {
      id: `00000000-0000-4000-8300-${padDigits(sample.seq, 12)}`,
      person_id: `00000000-0000-4000-8300-${padDigits(sample.seq, 12)}`,
      company: entity.name,
      name: sample.name,
      employee_number: sample.employeeNumber,
      org_unit_id: null,
      legal_entity_id: entity.id,
      workplace_id: site.id,
      org_unit: sample.place,
      position: roleLabel ? `${gradeLabel} · ${roleLabel}` : gradeLabel,
      status,
      hire_date: sample.hireDate,
      exit_date: sample.exitDate ?? null,
      status_since: sample.statusSince,
      expected_return_date: sample.expectedReturnDate,
      employment_type: sample.employmentTypeCode,
      register_review_required: false,
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
  };
  const { statusSamples } = saeonUniverse;
  return {
    onLeave: make(statusSamples.onLeave, "ON_LEAVE"),
    preHire: make(statusSamples.preHire, "PRE_HIRE"),
    exited: make(statusSamples.exited, "EXITED"),
  };
}

export function saeonLegalEntities(): { items: S["LegalEntity"][] } {
  const items: S["LegalEntity"][] = entities.map((entity, idx) => ({
    id: entity.id,
    biz_kind: "CORPORATION",
    crn: { value: entity.crn, display: entity.crnFormatted },
    needs_confirmation: false,
    identity_locked: true,
    founding: false,
    can_manage: true,
    closed_on: null,
    primary_workplace_id: entity.workplaces[0]?.id ?? null,
    head_office_workplace_id: entity.workplaces[0]?.id ?? null,
    head_office_has_no_workplace: false,
    current: {
      version: 1,
      effective_from: "2018-01-01",
      before_first_record: false,
      name: entity.name,
      display_name: entity.name,
      representation_mode: "SINGLE",
      representatives: [saeonUniverse.adminActor.name],
      additional_representatives: 0,
      change_mode: "GOVERNED",
    },
    scheduled: [],
    registrations: [],
    workplaces: entity.workplaces.map((site, siteIdx) => ({
      id: site.id,
      legal_entity_id: entity.id,
      registration_todo: false,
      is_primary: siteIdx === 0,
      is_head_office: site.headOffice,
      needs_confirmation: false,
      can_manage: true,
      current: {
        version: 1,
        effective_from: "2018-01-01",
        before_first_record: false,
        name: site.name,
        is_construction_site: false,
        status: "CONTINUING",
        change_mode: "GOVERNED",
      },
      insurance: [],
      withholding: { kind: site.headOffice ? "ENTITY_HEAD_OFFICE" : "WORKPLACE", workplace_id: site.id },
      headcount: Math.max(1, Math.floor(entity.headcount / entity.workplaces.length)),
      regular_workers: {
        status: "HOLD",
        value: null,
        basis: "LSA_DECREE_7_2",
        missing: [],
        live_headcount: Math.max(1, Math.floor(entity.headcount / entity.workplaces.length)),
      },
    })),
    regular_workers: {
      status: "HOLD",
      value: null,
      basis: "LSA_DECREE_7_2",
      missing: [],
      live_headcount: entity.headcount,
    },
    as_of: saeonUniverse.referenceDate,
    known_at: SAEON_AT,
    read_only: idx > 4,
  }));
  return { items };
}

export function saeonOrgUnits() {
  const structure = saeonOrgStructure();
  return structure.entities.flatMap(entity =>
    (entity.children ?? []).flatMap(site => [
      {
        id: site.id,
        name: site.name,
        kind: "SITE" as const,
        parentId: null,
        status: "ACTIVE" as const,
        effectiveFrom: "2020-01-01",
        headcount: site.headcount,
        updatedAt: SAEON_AT,
      },
      ...(site.children ?? []).map(dept => ({
        id: dept.id,
        name: dept.name,
        kind: "DEPARTMENT" as const,
        parentId: site.id,
        status: "ACTIVE" as const,
        effectiveFrom: "2020-01-01",
        headcount: dept.headcount,
        updatedAt: SAEON_AT,
      })),
    ]),
  );
}

export function saeonFilterEmployees(params: URLSearchParams): S["EmployeePage"] {
  const statuses = params.getAll("status").filter(Boolean);
  const search = (params.get("search") ?? "").trim().toLowerCase();
  const legalEntityId = params.get("legal_entity_id");
  const workplaceId = params.get("workplace_id");
  const registerReview = params.get("register_review_required") === "true";
  const contractEnding = Boolean(params.get("contract_ending_before"));
  const sort = params.get("sort") ?? "";
  const cursor = params.get("cursor") ?? "";
  const limit = Math.min(1000, Math.max(1, Number(params.get("limit") ?? 100) || 100));

  const samples = saeonStatusSampleEmployees();
  if (statuses.length === 1 && statuses[0] === "ON_LEAVE") {
    const items = search ? [samples.onLeave].filter(e => e.name.toLowerCase().includes(search)) : [samples.onLeave];
    return { items, total: items.length, limit, offset: 0, next_cursor: null };
  }
  if (statuses.length === 1 && statuses[0] === "PRE_HIRE") {
    const items = search ? [samples.preHire].filter(e => e.name.toLowerCase().includes(search)) : [samples.preHire];
    return { items, total: items.length, limit, offset: 0, next_cursor: null };
  }
  if (statuses.length === 1 && statuses[0] === "EXITED") {
    const items = search ? [samples.exited].filter(e => e.name.toLowerCase().includes(search)) : [samples.exited];
    return { items, total: items.length, limit, offset: 0, next_cursor: null };
  }

  const all = generateSaeonRoster();
  const isUnfilteredBoard =
    limit <= 100 &&
    !search &&
    !legalEntityId &&
    !workplaceId &&
    !registerReview &&
    !contractEnding &&
    !cursor &&
    (!sort || sort === "name");

  if (isUnfilteredBoard) {
    return {
      items: saeonRosterEmployees(1277, 22),
      total: all.length,
      limit: 22,
      offset: 1277,
      next_cursor: "offset:1299",
    };
  }

  let matched = all.filter(row => {
    if (legalEntityId && row.entityId !== legalEntityId) return false;
    if (workplaceId && (row.place === "" || row.workplaceId !== workplaceId)) return false;
    if (registerReview && !row.missingCode) return false;
    if (contractEnding && row.employmentTypeCode !== "CONTRACT") return false;
    if (search) {
      const hay = `${row.name} ${row.employeeNumber} ${row.place} ${row.entityName}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (sort) {
    const desc = sort.startsWith("-");
    const field = desc ? sort.slice(1) : sort;
    matched = [...matched].sort((a, b) => {
      const cmp =
        field === "employee_number"
          ? a.employeeNumber.localeCompare(b.employeeNumber)
          : field === "hire_date"
            ? a.hireDate.localeCompare(b.hireDate)
            : a.name.localeCompare(b.name, "ko");
      return desc ? -cmp : cmp;
    });
  }

  const offset = cursor.startsWith("offset:") ? Math.max(0, Number(cursor.slice(7)) || 0) : 0;
  const pageRows = matched.slice(offset, offset + limit).map(row => rowToEmployee(row));
  const nextOffset = offset + pageRows.length;
  return {
    items: pageRows,
    total: matched.length,
    limit,
    offset,
    next_cursor: nextOffset < matched.length ? `offset:${nextOffset}` : null,
  };
}

function findRosterOrSampleEmployee(id: string): { employee: S["Employee"]; rrn: string; rrnMasked: string; birthDate: string; basePay: number; missingCode: SaeonMissingCode | null } {
  const samples = saeonStatusSampleEmployees();
  if (id === SAEON_EXITED_ID) {
    return {
      employee: samples.exited,
      rrn: syntheticInvalidRrn("1986-04-12", 1, 9003),
      rrnMasked: maskRrn(syntheticInvalidRrn("1986-04-12", 1, 9003)),
      birthDate: "1986-04-12",
      basePay: BASE_PAY_BY_GRADE.MANAGER,
      missingCode: null,
    };
  }
  if (id === SAEON_ON_LEAVE_ID) {
    return {
      employee: samples.onLeave,
      rrn: syntheticInvalidRrn("1992-07-05", 2, 9001),
      rrnMasked: maskRrn(syntheticInvalidRrn("1992-07-05", 2, 9001)),
      birthDate: "1992-07-05",
      basePay: BASE_PAY_BY_GRADE.SENIOR_STAFF,
      missingCode: null,
    };
  }
  if (id === SAEON_PRE_HIRE_ID) {
    return {
      employee: samples.preHire,
      rrn: syntheticInvalidRrn("1999-11-18", 1, 9002),
      rrnMasked: maskRrn(syntheticInvalidRrn("1999-11-18", 1, 9002)),
      birthDate: "1999-11-18",
      basePay: BASE_PAY_BY_GRADE.STAFF,
      missingCode: null,
    };
  }
  const roster = generateSaeonRoster();
  const row = roster.find(r => r.id === id) ?? roster[1286]!;
  return {
    employee: rowToEmployee(row),
    rrn: row.rrn,
    rrnMasked: row.rrnMasked,
    birthDate: row.birthDate,
    basePay: BASE_PAY_BY_GRADE[row.gradeCode],
    missingCode: row.missingCode,
  };
}

export function saeonEmployeeDetail(id: string): S["EmployeeDetail"] {
  const found = findRosterOrSampleEmployee(id);
  const { employee, basePay } = found;
  const isHero = employee.id === SAEON_HERO_ID;
  const isExited = employee.status === "EXITED";
  const empType = (employee.employment_type ?? "REGULAR") as S["EmployeeEmploymentDetail"]["employment_type"];
  return {
    employee: isHero
      ? {
          ...employee,
          next_event: {
            id: `00000000-0000-4000-8900-${padDigits(saeonUniverse.heroDetails.scheduledEvent.seq, 12)}`,
            event_type: "TRANSFER",
            effective_date: saeonUniverse.heroDetails.scheduledEvent.effectiveDate,
          },
        }
      : employee,
    employment: {
      employment_type: empType,
      phone_e164: isHero ? saeonUniverse.hero.mobilePhoneMasked : maskMobilePhone(`010-0000-${employee.employee_number?.slice(-4) ?? "0000"}`),
      base_pay: String(basePay),
      currency: "KRW",
      contract_start_date: empType === "CONTRACT" ? employee.hire_date ?? null : null,
      contract_end_date: empType === "CONTRACT" ? "2026-12-31" : null,
    },
    allowed_events: isExited
      ? []
      : (["TRANSFER", "PROMOTE", "LEAVE_OF_ABSENCE", "APPOINT"] as const).map(event_type => ({
          event_type,
          required_signoffs: [],
        })),
    allowed_scheduled_events: isExited
      ? []
      : (["TRANSFER", "PROMOTE"] as const).map(event_type => ({
          event_type,
          required_signoffs: [],
        })),
    schedule_after: isHero ? saeonUniverse.heroDetails.scheduledEvent.effectiveDate : null,
    classification: {
      grade_id: null,
      job_title_id: null,
      position_kind_id: null,
      job_id: null,
      job_family_id: null,
    },
    ...(isExited
      ? {
          retention: {
            kept_until: saeonUniverse.statusSamples.exited.keptUntil,
            rule: {
              code: "LSA_42",
              value: 3,
              unit: "YEARS",
              instrument: saeonUniverse.statusSamples.exited.retentionInstrument,
              article: saeonUniverse.statusSamples.exited.retentionArticle,
              source_url: null,
              retrieved_on: null,
              provenance: null,
              release_disposition: saeonUniverse.statusSamples.exited.retentionDisposition,
              exception_grounds: [],
            },
          },
        }
      : {}),
  };
}

export function saeonPersonalFacts(id: string): S["EmployeePersonalFacts"] {
  const { employee } = findRosterOrSampleEmployee(id);
  const isHero = employee.id === SAEON_HERO_ID;
  return {
    employee_id: employee.id,
    updated_at: SAEON_AT,
    name_hanja: isHero ? saeonUniverse.heroDetails.nameHanja : null,
    name_en: isHero ? saeonUniverse.heroDetails.nameEn : null,
    nationality: saeonUniverse.hero.nationality,
    personal_email: isHero ? saeonUniverse.heroDetails.maskedEmail : null,
    emergency_contacts: isHero
      ? [
          {
            name: saeonUniverse.heroDetails.emergencyContactName,
            relation: "SPOUSE",
            phone: saeonUniverse.hero.mobilePhoneMasked,
            contact_notified: true,
          },
        ]
      : [],
    photo: null,
    group_service_start_date: employee.hire_date ?? null,
    countries: [],
  };
}

export function saeonRegisterFacts(id: string): S["EmployeeRegisterFacts"] {
  const { employee, missingCode } = findRosterOrSampleEmployee(id);
  const isHero = employee.id === SAEON_HERO_ID;
  const isExited = employee.status === "EXITED";
  return {
    employee_id: employee.id,
    updated_at: SAEON_AT,
    sex: missingCode === "GENDER" ? null : "MALE",
    address: missingCode === "ADDRESS" ? null : isHero ? saeonUniverse.heroDetails.maskedAddress : saeonUniverse.hero.address,
    careers: isHero
      ? [
          {
            employer_name: saeonUniverse.heroDetails.careerCompany,
            from: "2017-01-02",
            to: "2019-02-28",
            position: saeonUniverse.heroDetails.careerRole,
          },
        ]
      : [],
    exit_reason_code: isExited ? "RESIGNATION" : null,
    exit_reason_label: isExited ? saeonUniverse.hero.gradeLabel : null,
    register_note: null,
  };
}

export function saeonEmploymentFacts(id: string) {
  const { employee, basePay } = findRosterOrSampleEmployee(id);
  const empType = (employee.employment_type ?? "REGULAR") as "REGULAR" | "CONTRACT" | "PART_TIME" | "INTERN";
  return {
    employee_id: employee.id,
    hire_date: employee.hire_date ?? null,
    birth_date: "••••-••-••",
    work_email: null,
    id_type: "RRN" as const,
    employment: {
      employment_type: empType,
      worker_classification: "EMPLOYEE" as const,
      base_pay_won: basePay,
      pay_unit: "MONTHLY" as const,
      probation_end_date: null,
      probation_confirmed_at: null,
      probation_state: "NONE" as const,
      probation_days_left: null,
    },
    updated_at: SAEON_AT,
  };
}

export function saeonPersonRecords(id: string): S["PersonRecordList"] {
  const { employee } = findRosterOrSampleEmployee(id);
  const isHero = employee.id === SAEON_HERO_ID;
  const sections: S["PersonRecordList"]["sections"] = (
    ["EDUCATION", "QUALIFICATION", "MILITARY", "TRAINING", "LANGUAGE", "AWARD", "FAMILY"] as const
  ).map(section => ({ section, enabled: true }));
  const items: S["PersonRecordEntry"][] = isHero
    ? saeonUniverse.heroDetails.qualifications.map(q => ({
        id: `00000000-0000-4000-8800-${padDigits(q.seq, 12)}`,
        employee_id: employee.id,
        section: "QUALIFICATION",
        version: 1,
        voided: false,
        source: "MANUAL",
        created_at: SAEON_AT,
        revised_at: SAEON_AT,
        fields: {
          name: q.name,
          kind: "NATIONAL_TECHNICAL",
          issuer: q.issuer,
          acquired_on: q.acquiredOn,
        },
      }))
    : [];
  return { sections, items };
}

export function saeonLifecycleEvents(id: string): {
  items: S["EmployeeLifecycleEvent"][];
  head_version: number;
  next_cursor: string | null;
} {
  const { employee } = findRosterOrSampleEmployee(id);
  const events = saeonUniverse.heroDetails.lifecycleEvents;
  const signoffs: S["EmployeeLifecycleSignoffs"] = {
    privacy_notice_ack: true,
    korean_labor_law_ack: true,
    payroll_cutoff_ack: true,
    retirement_settlement_ack: true,
  };
  const actorId = saeonAdminUser().id;
  const actorName = saeonUniverse.adminActor.name;
  const items: S["EmployeeLifecycleEvent"][] = events.map(ev => ({
    id: `00000000-0000-4000-8900-${padDigits(ev.seq, 12)}`,
    employee_id: employee.id,
    event_type: ev.eventType as S["EmployeeLifecycleEvent"]["event_type"],
    from_status: ev.eventType === "ONBOARD" ? null : "ACTIVE",
    to_status: "ACTIVE",
    to_company: ev.toCompany ?? employee.company,
    to_org_unit: ev.toOrgUnit ?? employee.org_unit ?? null,
    from_position: ev.fromPosition ?? null,
    to_position: ev.toPosition,
    state: "APPLIED",
    applied_at: `${ev.effectiveDate}T00:00:00+09:00`,
    effective_date: ev.effectiveDate,
    comment: ev.reason,
    signoffs,
    created_by: actorId,
    created_by_name: actorName,
    created_at: `${ev.effectiveDate}T00:00:00+09:00`,
  }));
  if (employee.id === SAEON_HERO_ID) {
    const sched = saeonUniverse.heroDetails.scheduledEvent;
    items.unshift({
      id: `00000000-0000-4000-8900-${padDigits(sched.seq, 12)}`,
      employee_id: employee.id,
      event_type: "TRANSFER",
      from_status: "ACTIVE",
      to_status: "ACTIVE",
      from_org_unit: sched.fromOrgUnit,
      to_org_unit: sched.toOrgUnit,
      state: "SCHEDULED",
      effective_date: sched.effectiveDate,
      comment: sched.reason,
      signoffs,
      created_by: actorId,
      created_by_name: actorName,
      created_at: SAEON_AT,
    });
  }
  return { items, head_version: items.length, next_cursor: null };
}

export function saeonEndOptions(id: string): S["EmployeeEndOptions"] {
  const { employee } = findRosterOrSampleEmployee(id);
  const exited = employee.status === "EXITED";
  return {
    employee_id: employee.id,
    phase: "OPERATING",
    cancel: { allowed: false, refusal: "operating_period" },
    cancel_route: "VOID",
    attestation_required: false,
    register_confirmation_required: false,
    exit: exited ? { allowed: false, refusal: "already_exited" } : { allowed: true },
    updated_at: SAEON_AT,
    can_cancel: false,
    can_report_exit: !exited,
  };
}

export function saeonRrnStatus(id: string) {
  const { employee, rrnMasked } = findRosterOrSampleEmployee(id);
  return { employee_id: employee.id, recorded: true, can_record: false, masked: rrnMasked };
}

export function saeonRrnReveal(id: string) {
  const { rrn } = findRosterOrSampleEmployee(id);
  return { rrn, display_seconds: 30 };
}

export function saeonFieldReveal(id: string, field: string) {
  const { employee } = findRosterOrSampleEmployee(id);
  if (field === "PHONE") {
    return {
      value: employee.id === SAEON_HERO_ID ? saeonUniverse.hero.mobilePhone : `010-0000-${employee.employee_number?.slice(-4) ?? "4821"}`,
      display_seconds: 30,
    };
  }
  if (field === "EMAIL") {
    return { value: "hajun.yoon@saeon.test", display_seconds: 30 };
  }
  return {
    value: {
      postal_code: "17794",
      road_addr_part1: saeonUniverse.heroDetails.fullAddress,
      as_printed: saeonUniverse.heroDetails.fullAddress,
    },
    display_seconds: 30,
  };
}

export function saeonCertificates(employeeId: string): S["CertificatePage"] {
  const isHero = employeeId === SAEON_HERO_ID;
  const { employee } = findRosterOrSampleEmployee(employeeId);
  if (!isHero) return { items: [], next_cursor: null };
  return {
    items: saeonUniverse.heroDetails.certificates.map(cert => ({
      id: `00000000-0000-4000-8950-${padDigits(cert.seq, 12)}`,
      employee_id: employee.id,
      certificate_no: cert.certificateNo,
      name: employee.name,
      kind: cert.kind as "EMPLOYMENT" | "CAREER" | "EXIT",
      purpose: cert.purpose,
      issued_at: cert.issuedAt,
      voided_at: null,
      replaces_id: null,
    })),
    next_cursor: null,
  };
}

export function saeonPersonMonthAttendance(employeeId: string, month: string): S["AttendancePersonMonth"] {
  const { employee } = findRosterOrSampleEmployee(employeeId);
  return {
    employee_id: employee.id,
    employee_number: employee.employee_number ?? null,
    name: employee.name,
    month,
    days: [],
    history: [],
    totals: {
      recognised: 144 * 60,
      approved: 12 * 60,
      unrecognised: 0,
      not_worked: 0,
      blocking: 0,
      decision: 0,
      outside_scheduled: 0,
    },
    provisional: false,
    month_state: { state: "OPEN", lock_id: null, relock_at: null },
  };
}

export function saeonPayslipDraft(employeeId: string): S["PayrollPayslipDraft"] {
  const { employee, basePay } = findRosterOrSampleEmployee(employeeId);
  const yearMonth = saeonUniverse.payrollRun.yearMonth;
  return {
    employee_id: employee.id,
    employee_name: employee.name,
    period: { start: `${yearMonth}-01`, end: `${yearMonth}-31` },
    pay_date: saeonUniverse.payrollRun.payDate,
    contract: {
      id: `00000000-0000-4000-8960-000000000001`,
      effective_from: employee.hire_date ?? "2019-03-14",
      wage_kind: "MONTHLY",
      amount_won: basePay,
      monthly_standard_hours: 209,
      source_note: employee.company,
    },
    attendance: {
      period_start: `${yearMonth}-01`,
      period_end: `${yearMonth}-31`,
      worked_days: 18,
      clock_in_events: 18,
      clock_out_events: 18,
    },
    issuable: true,
    blockers: [],
    statutory_citations: [],
    gross_won: basePay + 200_000,
  };
}

export function saeonReasonCodes(domain: string): S["TenantReasonCode"][] {
  if (domain !== "rrn_reveal") return [];
  return saeonUniverse.reasonCodes.rrn_reveal.map((item, idx) => ({
    domain,
    code: item.code,
    label_ko: item.labelKo,
    label_en: item.code,
    requires_note: item.requiresNote,
    involuntary: false,
    notice_required: false,
    active: true,
    sort: idx + 1,
  }));
}

/** OpenAPI-typed `ApprovalDocumentDetail` for Saeon `OC-2026-0418` or secondary queue documents. */
export function saeonApprovalDocument(docId: string = SAEON_ORG_CHANGE_ID): S["ApprovalDocumentDetail"] {
  const { approval } = saeonUniverse;
  const team2 = saeonUniverse.entities[0]!.workplaces[1]!.departments[2]!.split(" › ").at(-1)!;
  const team3 = saeonUniverse.entities[0]!.workplaces[1]!.departments[3]!.split(" › ").at(-1)!;
  const roleKeys: S["OrgChangeApprovalRoleKey"][] = ["executive", "hr", "executive"];
  const queueEntry = approval.queue.find(entry => entry.id === docId || entry.documentNumber === docId);
  const isPrimary = !queueEntry || docId === SAEON_ORG_CHANGE_ID || docId === approval.documentNumber;
  const route: S["ApprovalDocument"]["route"] = approval.steps.map((step, index) => ({
    id: `00000000-0000-4000-8700-${padDigits(index + 1, 12)}`,
    role_key: roleKeys[index] ?? "hr",
    assignee: `${step.actor} · ${step.unit}`,
    state: step.status === "DONE" ? "done" : step.status === "CURRENT" ? "current" : "waiting",
  }));

  if (!isPrimary && queueEntry) {
    const entryRoute: S["ApprovalDocument"]["route"] = queueEntry.steps.map((step, index) => ({
      id: `00000000-0000-4000-8710-${padDigits(index + 1, 12)}`,
      role_key: (step.roleKey as S["OrgChangeApprovalRoleKey"]) ?? "hr",
      assignee: `${step.actor} · ${step.unit}`,
      state: step.status === "DONE" ? "done" : step.status === "CURRENT" ? "current" : "waiting",
    }));
    return {
      id: queueEntry.id,
      box: "pending",
      title: queueEntry.title,
      summary: queueEntry.summary,
      document_no: queueEntry.documentNumber,
      decision_refusal: null,
      source: { key: queueEntry.sourceKey, label: queueEntry.sourceLabel },
      status: { key: "IN_APPROVAL" },
      requester: { id: "00000000-0000-4000-8000-000000000002", name: queueEntry.requester },
      effective_date: queueEntry.effectiveDate,
      requested_at: `${queueEntry.requestedDate}T09:00:00+09:00`,
      facts: [{ key: "effective", label: t("approvals.field.effectiveDate"), value: fmtDate(queueEntry.effectiveDate) }],
      route: entryRoute,
      viewer: { kind: "org_change", id: SAEON_ORG_CHANGE_ID },
      body: [{ key: "summary", label: t("home.inbox.record.reason"), value: queueEntry.summary }],
      revision: 1,
      fingerprint: `sha256:saeon-${queueEntry.documentNumber.toLowerCase()}-r1`,
      consequence: "next_step",
      opinion_max: 1498,
      my_actions: {
        kind: "approve",
        reject: { consequence: "request_ends", reason_domain: "org_change_reject" },
      },
    };
  }

  return {
    id: docId,
    box: "pending",
    title: approval.title,
    summary: approval.reason,
    document_no: approval.documentNumber,
    decision_refusal: null,
    source: { key: "org_change", label: approval.category },
    status: { key: "IN_APPROVAL" },
    requester: {
      id: "00000000-0000-4000-8000-000000000002",
      name: approval.steps[0]?.actor ?? "",
    },
    effective_date: approval.effectiveDate,
    requested_at: `${approval.draftedDate}T09:00:00+09:00`,
    facts: [
      {
        key: "due",
        label: t("approvals.field.dueAt"),
        value: fmtDate(approval.dueDate),
      },
      {
        key: "transfer",
        label: t("home.worklist.impact.transfer"),
        value: t("home.worklist.personCount", { count: approval.transferredCount }),
      },
      {
        key: "cc",
        label: t("approvals.box.reference"),
        value: approval.ccActor,
      },
    ],
    route,
    viewer: { kind: "org_change", id: SAEON_ORG_CHANGE_ID },
    body: [
      {
        key: "headcount",
        label: team2,
        value: `${t("home.worklist.personCount", { count: approval.beforeHeadcount })} → ${t("home.worklist.personCount", { count: approval.afterHeadcount })}`,
      },
      {
        key: "dissolved",
        label: team3,
        value: `${t("home.worklist.personCount", { count: approval.transferredCount })} → ${t("orgPropose.diff.chip.dissolved")}`,
      },
      {
        key: "assignment",
        label: approval.ccActor,
        value: `${team3} → ${team2}`,
      },
      {
        key: "impact",
        label: t("home.worklist.impact.title"),
        value: approval.inFlightApprovalNote,
      },
    ],
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
    proposal_names: {
      "00000000-0000-4000-8400-000000000002": team2,
      "00000000-0000-4000-8400-000000000003": team3,
    },
    revision: 1,
    fingerprint: "sha256:saeon-oc-2026-0418-r1",
    consequence: "next_step",
    opinion_max: 1498,
    my_actions: {
      kind: "approve",
      reject: { consequence: "request_ends", reason_domain: "org_change_reject" },
    },
  };
}

/** OpenAPI-typed `ApprovalDocumentPage` for Saeon `/approvals` inbox queues. */
export function saeonApprovalsPage(
  box: S["ApprovalDocument"]["box"] = "pending",
  options: { q?: string; source?: string } = {},
): S["ApprovalDocumentPage"] {
  const { approval } = saeonUniverse;
  const primary = saeonApprovalDocument(approval.documentNumber);
  const allPending: S["ApprovalDocument"][] = [
    primary,
    ...approval.queue.map(entry => saeonApprovalDocument(entry.id)),
  ].map(({ body: _b, proposal: _p, proposal_names: _pn, revision: _r, fingerprint: _f, consequence: _c, opinion_max: _om, my_actions: _ma, ...summary }) => summary);

  const rawItems = box === "pending" ? allPending : [];
  const query = options.q?.trim().toLowerCase() ?? "";
  const items = rawItems.filter(item => {
    if (options.source && item.source.key !== options.source) return false;
    if (!query) return true;
    return [item.title, item.summary, item.document_no, item.requester.name]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  const sourceMap = new Map<string, { key: string; label: string; count: number }>();
  for (const item of rawItems) {
    const existing = sourceMap.get(item.source.key);
    if (existing) existing.count++;
    else sourceMap.set(item.source.key, { key: item.source.key, label: item.source.label, count: 1 });
  }

  return {
    items,
    focused: null,
    counts: {
      pending: allPending.length,
      upcoming: 2,
      requested: 3,
      reference: 2,
      completed: 8,
    },
    sources: [...sourceMap.values()],
    next_cursor: null,
  };
}
