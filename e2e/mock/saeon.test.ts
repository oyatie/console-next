// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import {
  brnChecksumValid,
  crnChecksumValid,
  formatBrn,
  formatCrn,
  generateSaeonRoster,
  maskMobilePhone,
  maskRrn,
  rrnChecksumValid,
  saeonAdminToken,
  saeonAdminUser,
  saeonApprovalDocument,
  saeonApprovalOrgChange,
  saeonApprovalsPage,
  saeonAttendanceSummary,
  saeonEmployeeFacets,
  saeonHeroScheduleMonth,
  saeonHeroToken,
  saeonHeroUser,
  saeonLeaveRequestView,
  saeonMyLeaveOverview,
  saeonOrgStructure,
  saeonPayrollRow,
  saeonRosterEmployees,
  saeonUniverse,
  saeonWorklistInbox,
  syntheticBrn,
  syntheticCrn,
  syntheticInvalidRrn,
} from "./saeon";

const RRN_CANDIDATE_RE = /(?<!\d)(\d{6})-?([1-8]\d{6})(?!\d)/g;

beforeAll(() => loadCatalog("ko"));

function checksumValidRrns(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(RRN_CANDIDATE_RE)) {
    const digits = `${match[1]}${match[2]}`;
    if (rrnChecksumValid(digits)) hits.push(match[0]);
  }
  return hits;
}

test("tenant counts, five legal entities, and forty workplaces match the Console target boards", () => {
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

test("hero employee, leave draft, and October 2026 payslip match the boarded Console facts and calendar corrections", () => {
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

test("roster generator and OpenAPI mock builders expose the 2,054-row universe cleanly", () => {
  const roster = generateSaeonRoster();
  expect(roster).toHaveLength(2054);
  const windowSlice = roster.slice(1277, 1299);
  expect(windowSlice).toHaveLength(22);
  expect(windowSlice.map(row => row.employeeNumber)).toEqual(saeonUniverse.rosterWindow.map(row => row.employeeNumber));
  expect(roster[1286]?.employeeNumber).toBe("10587");
  expect(checksumValidRrns(roster.map(row => row.rrn).join("\n"))).toEqual([]);

  const admin = saeonAdminUser();
  const adminToken = saeonAdminToken();
  const adminClaims = JSON.parse(Buffer.from(adminToken.access_token.split(".")[1]!, "base64url").toString()) as {
    sub: string;
    name: string;
  };
  const hero = saeonHeroUser();
  const org = saeonOrgStructure();
  const facets = saeonEmployeeFacets();
  const windowEmployees = saeonRosterEmployees();

  expect(admin.tenant?.name).toBe(saeonUniverse.tenantName);
  expect(adminClaims.sub).toBe(admin.id);
  expect(adminClaims.name).toBe(saeonUniverse.adminActor.name);
  expect(hero.employee_number).toBe("10587");
  expect(org.entities).toHaveLength(5);
  expect(org.entities.flatMap(entity => entity.children ?? [])).toHaveLength(40);
  expect(facets.total).toBe(2054);
  expect(windowEmployees).toHaveLength(22);
  expect(windowEmployees[9]?.employee_number).toBe("10587");
});

test("worklist, approval OC-2026-0418, attendance month, and Console payroll totals hold exact invariants", () => {
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

  const inbox = saeonWorklistInbox();
  expect(inbox.total).toBe(23);
  expect(inbox.items).toHaveLength(11);
  expect(inbox.items.filter(item => item.due_basis === "statutory")).toHaveLength(3);
  expect(inbox.items.find(item => item.ref === "OC-2026-0418")?.context?.command).toBe("approve");
  const leaveApproval = inbox.items.find(item => item.id === "leave-app-1");
  expect(leaveApproval?.kind).toBe("approval");
  expect(leaveApproval?.links[0]?.kind).toBe("approval_run");
  expect(leaveApproval?.context?.command).toBeUndefined();
  const attClose = inbox.items.find(item => item.id === "att-close-1");
  expect(attClose?.kind).toBe("period_unlock");
  expect(attClose?.context?.unlock).toBeUndefined();
  expect(inbox.items.find(item => item.id === "payroll-oct-1")?.kind).toBe("payroll");
  const orgChange = saeonApprovalOrgChange();
  expect(orgChange.code).toBe("OC-2026-0418");
  expect(orgChange.approvalSteps).toHaveLength(3);

  const approvalPage = saeonApprovalsPage("pending");
  expect(approvalPage.items).toHaveLength(6);
  expect(approvalPage.counts.pending).toBe(6);
  expect(approvalPage.items[0]?.document_no).toBe("OC-2026-0418");
  const approvalDoc = saeonApprovalDocument("OC-2026-0418");
  expect(approvalDoc.document_no).toBe("OC-2026-0418");
  expect(approvalDoc.proposal).toHaveLength(2);
  expect(Object.values(approvalDoc.proposal_names ?? {})).toHaveLength(2);
  expect(approvalDoc.my_actions.kind).toBe("approve");

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

  expect(saeonUniverse.payrollRun.headcount).toBe(757);
  expect(saeonUniverse.payrollRun.grossTotal).toBe(2_514_380_000);
  expect(saeonUniverse.payrollRun.deductionTotal).toBe(4_129_063 * 100);
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

  const hero = saeonHeroUser();
  const heroToken = saeonHeroToken();
  const heroClaims = JSON.parse(Buffer.from(heroToken.access_token.split(".")[1]!, "base64url").toString()) as {
    sub: string;
    name: string;
  };
  expect(heroClaims.sub).toBe(hero.id);
  expect(heroClaims.name).toBe(hero.display_name);

  const leaveOverview = saeonMyLeaveOverview();
  expect(leaveOverview.balance.accrued_units).toBe("15.000000");
  expect(leaveOverview.balance.used_units).toBe("5.500000");
  expect(leaveOverview.balance.remaining_units).toBe("9.500000");
  expect(leaveOverview.balance.filing_state).toBe("ready");
  expect(leaveOverview.requests.items).toHaveLength(3);
  expect(leaveOverview.requests.items.map(item => [item.start_date, item.days, item.status])).toEqual([
    ["2026-11-06", 0.5, "approved"],
    ["2026-10-23", 1, "approved"],
    ["2026-10-08", 1, "approved"],
  ]);
  expect(saeonMyLeaveOverview({ items: [] }).requests.items).toEqual([]);

  const homeBranchRequired = saeonMyLeaveOverview({ filingState: "home_branch_required" });
  expect(homeBranchRequired.balance.home_branch_id).toBeNull();

  const novSchedule = saeonHeroScheduleMonth("2026-11");
  expect(novSchedule.days).toHaveLength(30);
  expect(novSchedule.days.find(d => d.date === "2026-11-20")?.kind).toBe("WORK");
  expect(novSchedule.days.find(d => d.date === "2026-11-21")?.kind).toBe("WEEKLY_HOLIDAY");

  const created = saeonLeaveRequestView({
    idempotency_key: "00000000-0000-4000-8000-000000000001",
    leave_type: "half_day",
    partial_day_period: "am",
    start_date: "2026-11-20",
    end_date: "2026-11-20",
  });
  expect(created.days).toBe(0.5);
  expect(created.partial_day_period).toBe("am");
});
