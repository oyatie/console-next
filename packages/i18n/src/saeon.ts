// SPDX-License-Identifier: LicenseRef-Proprietary
import raw from "./catalogs/saeon-universe.json";
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
  type SaeonEmploymentTypeCode,
  type SaeonEntity,
  type SaeonGradeCode,
  type SaeonMissingCode,
  type SaeonRoleCode,
  type SaeonRosterRow,
};

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
