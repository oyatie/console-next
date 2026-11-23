// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";
import type { FilingPage, FilingTask, PayrollRun, RegisterPage } from "@console/api/pending";
import { t } from "@console/i18n";
import { maskRrn, padDigits, syntheticInvalidRrn } from "./saeon-ids";
import { SAEON_HERO_ID, saeonPayGroups, saeonPayrollRates, saeonPayrollRow, saeonUniverse } from "./saeon";

type S = components["schemas"];

export function saeonPayrollRunsPage(opts?: {
  payGroupId?: string | null;
  legalEntityId?: string | null;
  offset?: number;
  limit?: number;
  totalCount?: number;
}): S["PayrollRunPage"] {
  const groups = saeonPayGroups().items;
  const totalCount = opts?.totalCount ?? 12;
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 50;

  const months = ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01"];
  const statuses: PayrollRun["status"][] = [
    "CALCULATED",
    "PAID",
    "ISSUED",
    "SUBMITTED",
    "APPROVED",
    "READY_FOR_REVIEW",
    "ATTENDANCE_CLOSED",
  ];

  const all: PayrollRun[] = Array.from({ length: totalCount }, (_, i) => {
    const group = groups[i % groups.length]!;
    const month = months[Math.floor(i / groups.length) % months.length]!;
    const [yyyy, mm] = month.split("-") as [string, string];
    const prevMm = mm === "01" ? "12" : padDigits(Number(mm) - 1, 2);
    const prevYyyy = mm === "01" ? String(Number(yyyy) - 1) : yyyy;
    return {
      id: i === 0 ? "00000000-0000-4000-8600-000000000011" : `00000000-0000-4000-8650-${padDigits(i + 1, 12)}`,
      legal_entity_id: group.legal_entity_id,
      pay_group_id: group.id,
      kind: "REGULAR",
      attribution_month: month,
      pay_date: `${month}-25`,
      period_start: `${month}-01`,
      period_end: `${month}-28`,
      variable_period_start: `${prevYyyy}-${prevMm}-16`,
      variable_period_end: `${month}-15`,
      source_label: `${group.name} · ${month}`,
      status: statuses[i % statuses.length]!,
      calculation_enabled: true,
      created_at: "2026-10-25T09:00:00Z",
      updated_at: "2026-10-25T09:00:00Z",
    };
  });

  const filtered = all.filter(
    (run) =>
      (!opts?.payGroupId || run.pay_group_id === opts.payGroupId) &&
      (!opts?.legalEntityId || run.legal_entity_id === opts.legalEntityId),
  );

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  };
}

export function saeonRunPreview(payGroupId: string) {
  const group = saeonPayGroups().items.find((g) => g.id === payGroupId) ?? saeonPayGroups().items[0]!;
  return {
    pay_group_id: group.id,
    legal_entity_id: group.legal_entity_id,
    kind: "REGULAR" as const,
    attribution_month: "2026-11",
    pay_date: "2026-11-25",
    pay_date_clamped: false,
    period_start: "2026-11-01",
    period_end: "2026-11-30",
    variable_period_start: "2026-10-16",
    variable_period_end: "2026-11-15",
  };
}

export function saeonHeroPayslipDraft(employeeId = SAEON_HERO_ID): S["PayrollPayslipDraft"] {
  const row = saeonPayrollRow(saeonUniverse.hero.employeeNumber, saeonUniverse.hero.gradeCode, 6, true);
  const rates = saeonPayrollRates();
  const pensionInstrument: S["PayrollStatutoryInstrument"] = {
    name_ko: t("enum.insurer.NPS"),
    article_ko: saeonUniverse.statutory.articles.nps,
    promulgation_ko: "2026-01-01",
    enforced_on: "2026-01-01",
    url: "https://www.nps.or.kr",
    retrieved_on: "2026-10-29",
  };
  const healthInstrument: S["PayrollStatutoryInstrument"] = {
    name_ko: t("enum.insurer.NHIS"),
    article_ko: saeonUniverse.statutory.articles.nhis,
    promulgation_ko: "2026-01-01",
    enforced_on: "2026-01-01",
    url: "https://www.nhis.or.kr",
    retrieved_on: "2026-10-29",
  };
  const taxInstrument: S["PayrollStatutoryInstrument"] = {
    name_ko: t("payroll.run.col.incomeTax"),
    article_ko: saeonUniverse.statutory.articles.incomeTax,
    promulgation_ko: "2026-01-01",
    enforced_on: "2026-01-01",
    url: "https://www.nts.go.kr",
    retrieved_on: "2026-10-29",
  };

  return {
    employee_id: employeeId,
    employee_name: saeonUniverse.hero.name,
    period: { start: "2026-10-01", end: "2026-10-31" },
    pay_date: "2026-11-25",
    contract: {
      id: "00000000-0000-4000-8710-000000000001",
      effective_from: "2026-01-01",
      wage_kind: "MONTHLY",
      amount_won: row.basePay,
      monthly_standard_hours: 209,
      source_note: `${saeonUniverse.hero.entityName} (2026)`,
    },
    attendance: {
      period_start: "2026-10-01",
      period_end: "2026-10-31",
      worked_days: 20,
      clock_in_events: 20,
      clock_out_events: 20,
    },
    issuable: false,
    blockers: ["WITHHOLDING_NOT_COMPUTED"],
    statutory_citations: rates.items,
    earnings: [
      { code: "BASE_PAY", label_ko: t("payroll.run.col.basePay"), amount_won: row.basePay, note_ko: t("payroll.rule.MONTHLY") },
    ],
    gross_won: row.basePay,
    deductions: [
      {
        code: "NationalPension",
        label_ko: t("enum.insurer.NPS"),
        basis_kind: "MonthlyStandardIncome",
        basis_won: row.basePay,
        rate_num: 45,
        rate_den: 1000,
        total_won: row.nationalPension * 2,
        employee_won: row.nationalPension,
        employer_only: false,
        blocked_by: null,
        total_rounding: "HALF_EVEN",
        employee_rounding: "HALF_EVEN",
        instrument: pensionInstrument,
        share_instrument: pensionInstrument,
        provenance_ko: t("payroll.run.rateNote.taxable", { rate: "4.5" }),
      },
      {
        code: "HealthInsurance",
        label_ko: t("enum.insurer.NHIS"),
        basis_kind: "MonthlyStandardIncome",
        basis_won: row.basePay,
        rate_num: 3545,
        rate_den: 100_000,
        total_won: row.healthInsurance * 2,
        employee_won: row.healthInsurance,
        employer_only: false,
        blocked_by: null,
        total_rounding: "HALF_EVEN",
        employee_rounding: "HALF_EVEN",
        instrument: healthInstrument,
        share_instrument: healthInstrument,
        provenance_ko: t("payroll.run.rateNote.taxable", { rate: "3.545" }),
      },
    ],
    minimum_wage_check: {
      hourly_floor_won: 10_320,
      monthly_209h_floor_won: 2_156_880,
      monthly_standard_hours: 209,
      effective_hourly_won: Math.floor(row.basePay / 209),
      passes: true,
      instrument: pensionInstrument,
    },
    total_employee_insurance_won: row.nationalPension + row.healthInsurance + row.longTermCare + row.employmentInsurance,
    remainder_after_insurance_won: row.basePay - (row.nationalPension + row.healthInsurance + row.longTermCare + row.employmentInsurance),
    net_pay_won: null,
    not_computed: [
      {
        code: "INCOME_TAX",
        label_ko: t("payslip.deduction.INCOME_TAX"),
        reason_ko: t("payroll.employee.withholdingMissing"),
        instrument: taxInstrument,
      },
    ],
  };
}

export function saeonStatutoryWorkplaces() {
  return saeonUniverse.entities.slice(0, 3).flatMap((entity) =>
    entity.workplaces.map((wp) => ({
      id: wp.id,
      name: wp.name,
      entity_name: entity.name,
    })),
  );
}

const CITATION_NHIS = {
  instrument: "NHIS Act",
  article: "Art. 7",
  promulgation: "2026-01-01",
  source_url: "https://www.nhis.or.kr",
  enforced_on: "2026-01-01",
};

const CITATION_NPS = {
  instrument: "NPS Act",
  article: "Art. 21",
  promulgation: "2026-01-01",
  source_url: "https://www.nps.or.kr",
  enforced_on: "2026-01-01",
};

const CITATION_EI = {
  instrument: "EI Act",
  article: "Art. 15",
  promulgation: "2026-01-01",
  source_url: "https://www.ei.go.kr",
  enforced_on: "2026-01-01",
};

export function saeonStatutoryFilings(): FilingTask[] {
  const precision = saeonUniverse.entities[0]!;
  const ulsan = precision.workplaces[0]!;
  const pyeongtaek = precision.workplaces[1]!;
  const electronics = saeonUniverse.entities[1]!;
  const daejeon = electronics.workplaces[0]!;
  const rows = saeonUniverse.payrollRun.windowRows;
  const r1 = rows[1] ?? { name: saeonUniverse.hero.name, employeeNumber: "10313" };
  const r2 = rows[2] ?? { name: saeonUniverse.hero.name, employeeNumber: "10219" };
  const r3 = rows[3] ?? { name: saeonUniverse.hero.name, employeeNumber: "10088" };
  const r4 = rows[4] ?? { name: saeonUniverse.hero.name, employeeNumber: "20105" };

  return [
    {
      event_id: "00000000-0000-4000-8930-000000000001",
      filing_obligation_id: "00000000-0000-4000-8940-000000000001",
      employee_id: "00000000-0000-4000-8300-000000000011",
      name: r1.name,
      employee_number: r1.employeeNumber,
      kind: "ACQUIRE",
      insurer: "NHIS",
      effective_date: "2026-11-02",
      legal_entity_id: precision.id,
      workplace_id: pyeongtaek.id,
      workplace_name: pyeongtaek.name,
      due_date: "2026-11-16",
      due_in_days: -2,
      deadline_status: "HOLD",
      version: 1,
      completed_on: null,
      receipt_number: null,
      loss_code: null,
      detail: null,
      opens_on: "2026-11-02",
      target_on: "2026-11-16",
      due_on: "2026-11-16",
      dates: {
        opens_on: "2026-11-02",
        target_on: "2026-11-16",
        due_on: "2026-11-16",
        legal_latest_candidate: "2026-11-16",
        conservative: true,
        without_delay: false,
        holiday_roll_unverified: true,
      },
      basis: {
        code: "nhis-acquire",
        citation: CITATION_NHIS,
        applicability_citations: [],
        remuneration_required: true,
        exclusions: [],
        covered_by: null,
        penalty: null,
      },
      applicability: { status: "APPLIES" },
      applicability_facts: { daily: false, foreign: false },
      can_record_sensitive_facts: true,
      birth_date_known: true,
      state: "PENDING",
      record_action: null,
      not_applicable_reason: null,
      not_applicable_options: ["SHORT_HOURS", "DAILY_UNDER_MONTH", "OTHER_LEGAL_GROUND"],
      total_remuneration_won: 3_650_000,
      is_request: false,
      acquired_on: "2026-11-02",
      loss_options: [],
    },
    {
      event_id: "00000000-0000-4000-8930-000000000002",
      filing_obligation_id: "00000000-0000-4000-8940-000000000002",
      employee_id: "00000000-0000-4000-8300-000000000012",
      name: r2.name,
      employee_number: r2.employeeNumber,
      kind: "ACQUIRE",
      insurer: "NPS",
      effective_date: "2026-11-05",
      legal_entity_id: precision.id,
      workplace_id: pyeongtaek.id,
      workplace_name: pyeongtaek.name,
      due_date: "2026-12-15",
      due_in_days: 3,
      deadline_status: "CHECKED",
      version: 1,
      completed_on: null,
      receipt_number: null,
      loss_code: null,
      detail: null,
      opens_on: "2026-11-05",
      target_on: "2026-12-15",
      due_on: "2026-12-15",
      dates: null,
      basis: {
        code: "nps-acquire",
        citation: CITATION_NPS,
        applicability_citations: [],
        remuneration_required: false,
        exclusions: [],
        covered_by: null,
        penalty: null,
      },
      applicability: { status: "APPLIES" },
      applicability_facts: { daily: false, foreign: false },
      can_record_sensitive_facts: true,
      birth_date_known: true,
      state: "PENDING",
      record_action: null,
      not_applicable_reason: null,
      not_applicable_options: ["AGE_LIMIT", "SHORT_HOURS"],
      total_remuneration_won: 4_100_000,
      is_request: false,
      acquired_on: "2026-11-05",
      loss_options: [],
    },
    {
      event_id: "00000000-0000-4000-8930-000000000003",
      filing_obligation_id: "00000000-0000-4000-8940-000000000003",
      employee_id: "00000000-0000-4000-8300-000000009003",
      name: r3.name,
      employee_number: r3.employeeNumber,
      kind: "LOSE",
      insurer: "EI",
      effective_date: "2026-10-31",
      legal_entity_id: precision.id,
      workplace_id: ulsan.id,
      workplace_name: ulsan.name,
      due_date: "2026-11-15",
      due_in_days: 0,
      deadline_status: "CHECKED",
      version: 1,
      completed_on: null,
      receipt_number: null,
      loss_code: null,
      detail: null,
      opens_on: "2026-11-01",
      target_on: "2026-11-15",
      due_on: "2026-11-15",
      dates: null,
      basis: {
        code: "ei-lose",
        citation: CITATION_EI,
        applicability_citations: [],
        remuneration_required: true,
        exclusions: [],
        covered_by: null,
        penalty: null,
      },
      applicability: { status: "APPLIES" },
      applicability_facts: {},
      can_record_sensitive_facts: true,
      birth_date_known: true,
      state: "PENDING",
      record_action: null,
      not_applicable_reason: null,
      not_applicable_options: [],
      total_remuneration_won: 4_200_000,
      is_request: false,
      acquired_on: "2024-03-04",
      loss_options: [
        { code: "11", label: "11", requires_detail: false, held: false },
        { code: "23", label: "23", requires_detail: true, held: true },
      ],
    },
    {
      event_id: "00000000-0000-4000-8930-000000000004",
      filing_obligation_id: "00000000-0000-4000-8940-000000000004",
      employee_id: "00000000-0000-4000-8300-000000000014",
      name: r4.name,
      employee_number: r4.employeeNumber,
      kind: "ACQUIRE",
      insurer: "IACI",
      effective_date: "2026-11-10",
      legal_entity_id: electronics.id,
      workplace_id: daejeon.id,
      workplace_name: daejeon.name,
      due_date: null,
      due_in_days: 12,
      deadline_status: "HOLD",
      version: 1,
      completed_on: null,
      receipt_number: null,
      loss_code: null,
      detail: null,
      opens_on: "2026-11-10",
      target_on: null,
      due_on: null,
      dates: null,
      basis: null,
      applicability: { status: "UNKNOWN", missing: ["monthly_hours"] },
      applicability_facts: {},
      can_record_sensitive_facts: false,
      birth_date_known: false,
      state: "LEGAL_REVIEW",
      record_action: null,
      not_applicable_reason: null,
      not_applicable_options: [],
      total_remuneration_won: null,
      is_request: false,
      acquired_on: "2026-11-10",
      loss_options: [],
    },
    {
      event_id: "00000000-0000-4000-8930-000000000005",
      filing_obligation_id: "00000000-0000-4000-8940-000000000005",
      employee_id: SAEON_HERO_ID,
      name: saeonUniverse.hero.name,
      employee_number: saeonUniverse.hero.employeeNumber,
      kind: "RESUME",
      insurer: "EI",
      effective_date: "2026-10-20",
      legal_entity_id: precision.id,
      workplace_id: ulsan.id,
      workplace_name: ulsan.name,
      due_date: "2026-11-15",
      due_in_days: null,
      deadline_status: "CHECKED",
      version: 2,
      completed_on: "2026-11-04",
      receipt_number: "EDI-20261104-0082",
      loss_code: null,
      detail: null,
      opens_on: "2026-10-20",
      target_on: "2026-11-15",
      due_on: "2026-11-15",
      dates: null,
      basis: {
        code: "ei-resume",
        citation: CITATION_EI,
        applicability_citations: [],
        remuneration_required: false,
        exclusions: [],
        covered_by: null,
        penalty: null,
      },
      applicability: { status: "APPLIES" },
      applicability_facts: {},
      can_record_sensitive_facts: true,
      birth_date_known: true,
      state: "DONE",
      record_action: "COMPLETE",
      not_applicable_reason: null,
      not_applicable_options: [],
      total_remuneration_won: null,
      is_request: false,
      acquired_on: "2021-03-02",
      loss_options: [],
    },
  ];
}

export function filterSaeonStatutoryFilings(query: URLSearchParams): FilingPage {
  const all = saeonStatutoryFilings();
  const workplaceId = query.get("workplace_id");
  const state = query.get("state") ?? "PENDING";
  const insurer = query.get("insurer");
  const search = query.get("search")?.trim().toLowerCase() ?? "";

  const items = all.filter((item) => {
    if (workplaceId && item.workplace_id !== workplaceId) return false;
    if (insurer && item.insurer !== insurer) return false;
    if (state === "DONE" ? item.state !== "DONE" : item.state === "DONE") return false;
    if (search && !item.name.toLowerCase().includes(search) && !(item.employee_number ?? "").toLowerCase().includes(search)) {
      return false;
    }
    return true;
  });

  const pendingCount = all.filter((item) => item.state !== "DONE").length;
  return {
    items,
    total: items.length,
    pending: pendingCount,
    next: null,
  };
}

export function saeonWorkerRegisterPage(workplaceId: string, asOf = "2026-11-01"): RegisterPage {
  const workplaces = saeonStatutoryWorkplaces();
  const wp = workplaces.find((w) => w.id === workplaceId) ?? workplaces[1]!;
  const second = saeonUniverse.payrollRun.windowRows[1] ?? { name: saeonUniverse.hero.name, employeeNumber: "10313" };
  return {
    as_of: asOf,
    workplace_id: wp.id,
    workplace_name: wp.name,
    headers: [
      t("statutory.employeeNumber"),
      t("statutory.employee"),
      t("statutory.birth_date"),
      t("empCard.reg.item.address"),
      t("empCard.reg.item.job"),
      t("empCard.reg.item.contract"),
    ],
    items: [
      {
        employee_id: SAEON_HERO_ID,
        cells: [
          saeonUniverse.hero.employeeNumber,
          saeonUniverse.hero.name,
          maskRrn(syntheticInvalidRrn("1991-04-12", 1, 1001)),
          saeonUniverse.statutory.registerRows[0]!.address!,
          saeonUniverse.statutory.registerRows[0]!.duty,
          "2021-03-02",
        ],
        missing: [],
      },
      {
        employee_id: "00000000-0000-4000-8300-000000000011",
        cells: [
          second.employeeNumber,
          second.name,
          "••••-••-••",
          "",
          saeonUniverse.statutory.registerRows[1]!.duty,
          "2026-11-02",
        ],
        missing: ["address"],
      },
    ],
    total: 2,
    next: null,
  };
}
