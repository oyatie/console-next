// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import {
  brnChecksumValid,
  crnChecksumValid,
  formatBrn,
  formatCrn,
  generateSaeonRoster,
  maskMobilePhone,
  maskRrn,
  rrnChecksumValid,
  saeonAttendanceSummary,
  saeonPayrollRow,
  saeonUniverse,
  syntheticBrn,
  syntheticCrn,
  syntheticInvalidRrn,
} from "./saeon";

const RRN_CANDIDATE_RE = /(?<!\d)(\d{6})-?([1-8]\d{6})(?!\d)/g;

function checksumValidRrns(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(RRN_CANDIDATE_RE)) {
    const digits = `${match[1]}${match[2]}`;
    if (rrnChecksumValid(digits)) hits.push(match[0]);
  }
  return hits;
}

test("tenant counts, five legal entities, and forty workplaces match the Control room target", () => {
  expect(saeonUniverse.referenceDate).toBe("2026-11-10");
  expect(saeonUniverse.counts).toEqual({
    active: 2054,
    leave: 37,
    joining: 25,
    exited: 362,
    missingInfo: 546,
    missingAddress: 353,
    probationEnding: 43,
    contractEndingSoon: 42,
  });

  expect(saeonUniverse.entities).toHaveLength(5);
  expect(saeonUniverse.entities.map(entity => entity.headcount)).toEqual([757, 353, 137, 487, 377]);
  expect(saeonUniverse.entities.map(entity => entity.workplaces.length)).toEqual([5, 4, 3, 16, 12]);
  const allWorkplaces = saeonUniverse.entities.flatMap(entity => entity.workplaces);
  expect(allWorkplaces).toHaveLength(40);
});

test("every synthetic CRN and BRN uses the unallocated 000 prefix, passes its check digit, and avoids RRN collisions", () => {
  const seenCrns = new Set<string>();
  const seenBrns = new Set<string>();

  for (const [entityIndex, entity] of saeonUniverse.entities.entries()) {
    const crn = syntheticCrn(entityIndex + 1);
    expect(crn).toBe(entity.crn);
    expect(crn.startsWith("000")).toBe(true);
    expect(crn).toHaveLength(13);
    expect(crnChecksumValid(crn)).toBe(true);
    expect(formatCrn(crn)).toMatch(/^000\d{3}-9\d{6}$/);
    expect(checksumValidRrns(`${crn} ${formatCrn(crn)}`)).toEqual([]);
    seenCrns.add(crn);

    for (const [siteIndex, site] of entity.workplaces.entries()) {
      const brn = syntheticBrn(entityIndex + 1, siteIndex, siteIndex === 0);
      expect(brn).toBe(site.brn);
      expect(brn.startsWith("000")).toBe(true);
      expect(brn).toHaveLength(10);
      expect(brnChecksumValid(brn)).toBe(true);
      expect(formatBrn(brn)).toMatch(/^000-8[15]-\d{5}$/);
      seenBrns.add(brn);
    }
  }

  expect(seenCrns.size).toBe(5);
  expect(seenBrns.size).toBe(40);
});

test("every generated RRN preserves a valid calendar birth date while deterministically failing the RRN checksum", () => {
  const samples: string[] = [];
  for (let i = 0; i < 250; i++) {
    const year = 1970 + (i % 38);
    const month = String((i % 12) + 1).padStart(2, "0");
    const day = String((i % 28) + 1).padStart(2, "0");
    const gender: 1 | 2 | 3 | 4 = year >= 2000 ? (i % 2 === 0 ? 3 : 4) : (i % 2 === 0 ? 1 : 2);
    const rrn = syntheticInvalidRrn(`${year}-${month}-${day}`, gender, 1000 + i);
    const digits = rrn.replace("-", "");
    expect(rrn).toMatch(/^\d{6}-[1-8]\d{6}$/);
    expect(rrnChecksumValid(digits)).toBe(false);
    samples.push(rrn, digits);
  }
  expect(checksumValidRrns(samples.join("\n"))).toEqual([]);
  expect(checksumValidRrns(JSON.stringify(saeonUniverse))).toEqual([]);
});

test("hero employee, leave draft, and October 2026 payslip match the boarded Control room facts and calendar corrections", () => {
  const { hero } = saeonUniverse;
  expect(hero.employeeNumber).toBe("10587");
  expect(hero.hireDate).toBe("2019-03-14");
  expect(hero.birthDate).toBe("1994-08-21");
  expect(maskRrn(hero.rrn)).toBe("940821-1●●●●●●");
  expect(maskMobilePhone(hero.mobilePhone)).toBe("010-●●●●-4821");
  expect(rrnChecksumValid(hero.rrn.replace("-", ""))).toBe(false);

  // Leave balance & Friday correction (2026-11-20 is Friday; 2026-11-21 is Saturday).
  expect(hero.leave).toEqual({
    grantedDays: 15,
    usedDays: 5.5,
    remainingDays: 9.5,
    draftRequestDays: 1,
    remainingAfterDraftDays: 8.5,
    draftDate: "2026-11-20",
  });
  expect(new Date("2026-11-20T00:00:00Z").getUTCDay()).toBe(5);

  const heroPay = saeonPayrollRow(hero.employeeNumber, hero.gradeCode, 12, true);
  expect(heroPay).toEqual({
    employeeNumber: "10587",
    overtimeHours: 12,
    basePay: 3_100_000,
    overtimePay: 267_000,
    mealAllowance: 200_000,
    grossPay: 3_567_000,
    taxablePay: 3_367_000,
    nationalPension: 151_515,
    healthInsurance: 119_360,
    longTermCare: 15_457,
    employmentInsurance: 30_303,
    incomeTax: 98_740,
    localIncomeTax: 9_870,
    totalDeductions: 425_245,
    netPay: 3_141_755,
    bankAccountRegistered: true,
  });
});

test("roster generator produces 2,054 deterministic rows with the 22 boarded rows at 1278..1299 and hero at 1287", () => {
  const roster = generateSaeonRoster();
  expect(roster).toHaveLength(2054);
  const windowSlice = roster.slice(1277, 1299);
  expect(windowSlice).toHaveLength(22);
  expect(windowSlice.map(row => row.employeeNumber)).toEqual(saeonUniverse.rosterWindow.map(row => row.employeeNumber));
  expect(roster[1286]?.employeeNumber).toBe("10587");
  expect(checksumValidRrns(roster.map(row => row.rrn).join("\n"))).toEqual([]);
});

test("worklist, approval OC-2026-0418, attendance month, and Control room payroll totals hold exact invariants", () => {
  expect(saeonUniverse.worklist.totalCount).toBe(23);
  expect(saeonUniverse.worklist.approvalCount).toBe(4);
  expect(saeonUniverse.worklist.todayCount).toBe(3);
  expect(saeonUniverse.worklist.overdueCount).toBe(2);
  expect(saeonUniverse.worklist.items).toHaveLength(10);
  expect(saeonUniverse.worklist.items.filter(item => item.statutory)).toHaveLength(3);

  expect(saeonUniverse.approval.documentNumber).toBe("OC-2026-0418");
  expect(saeonUniverse.approval.effectiveDate).toBe("2026-11-17");
  expect(saeonUniverse.approval.steps).toHaveLength(3);
  expect(saeonUniverse.approval.transferredCount).toBe(12);

  const attendance = saeonAttendanceSummary();
  expect(attendance).toEqual({
    memberCount: 12,
    scheduledWorkDays: 18,
    weekdayHolidays: 4,
    totalWorkDays: 206.5,
    totalLeaveDays: 10.5,
    totalApprovedOvertimeHours: 53,
    openExceptionCount: 4,
    canCloseMonth: false,
  });

  // Control room target payroll run totals.
  expect(saeonUniverse.payrollRun.headcount).toBe(757);
  expect(saeonUniverse.payrollRun.grossTotal).toBe(2_514_380_000);
  expect(saeonUniverse.payrollRun.deductionTotal).toBe(412_906_300);
  expect(saeonUniverse.payrollRun.netTotal).toBe(2_101_473_700);
  expect(saeonUniverse.payrollRun.grossTotal - saeonUniverse.payrollRun.deductionTotal).toBe(saeonUniverse.payrollRun.netTotal);
  expect(saeonUniverse.payrollRun.missingBankAccountCount).toBe(2);

  const registerRows = saeonUniverse.payrollRun.windowRows.map(row =>
    saeonPayrollRow(row.employeeNumber, row.gradeCode, row.overtimeHours, row.bankAccountRegistered),
  );
  expect(registerRows).toHaveLength(10);
  expect(registerRows.reduce((sum, row) => sum + row.grossPay, 0)).toBe(36_705_800);
  expect(registerRows.reduce((sum, row) => sum + row.totalDeductions, 0)).toBe(4_383_272);
  expect(registerRows.reduce((sum, row) => sum + row.netPay, 0)).toBe(32_322_528);
});
