// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";
import raw from "./saeon-universe.json";
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
