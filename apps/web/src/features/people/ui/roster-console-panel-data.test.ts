// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtKrw } from "@console/i18n/format";
import { buildPanelBasicItems, buildPanelSummaryItems } from "./roster-console-panel-data";

type BasicOpts = Parameters<typeof buildPanelBasicItems>[0];
type SummaryOpts = Parameters<typeof buildPanelSummaryItems>[0];

beforeAll(() => loadCatalog("ko"));

const employee = { id: "emp-1", status: "ACTIVE", hire_date: "2024-03-04", leave_remaining: null } as unknown as BasicOpts["e"];

test("the record pane states no insurance enrolment the server did not send", () => {
  const items = buildPanelBasicItems({
    e: employee,
    c: { readable: true, register: { data: undefined }, personal: { data: undefined } } as unknown as BasicOpts["c"],
    who: "",
    today: "2026-11-24",
    gradeRole: "",
  });
  // A hire date says nothing about enrolment in the four insurances, so the pane has no section built from it.
  expect(Object.keys(items).sort()).toEqual(["employmentItems", "personalItems"]);
});

test("the month summary counts no absence as leave and shows no pay before tax as net pay", () => {
  const attMonth = {
    days: [
      { recognition: { recognised: 480 }, marks: [] },
      { recognition: { recognised: 0 }, marks: ["ABSENT"] },
      { recognition: { recognised: 0 }, marks: ["ABSENT"] },
    ],
    totals: { approved: 90 },
  } as unknown as SummaryOpts["attMonth"];
  const payDraft = { gross_won: 3_000_000, total_employee_insurance_won: 300_000, remainder_after_insurance_won: 2_700_000 } as unknown as SummaryOpts["payDraft"];
  const items = buildPanelSummaryItems({ e: employee as SummaryOpts["e"], month: "2026-10", monthNum: 10, payDate: "2026-11-25", attMonth, payDraft });
  expect(items.find(item => item.key === "att")?.value).toBe(t("people.panel.summary.attDetail", { work: 1, ot: 1.5 }));
  const pay = String(items.find(item => item.key === "pay")?.value);
  expect(pay).toBe(t("people.panel.summary.payDetail", { gross: fmtKrw("3000000"), ded: fmtKrw("300000") }));
  expect(pay).not.toContain(fmtKrw("2700000"));
});
