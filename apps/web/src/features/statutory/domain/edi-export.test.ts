// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, it } from "vitest";
import type { FilingTask } from "../../../reference/statutory/api";
import { buildStatutoryEdiCsv, isEdiEligible } from "./edi-export";

function makeTask(overrides: Partial<FilingTask> = {}): FilingTask {
  return {
    event_id: "evt-1",
    filing_obligation_id: "obl-1",
    employee_id: "emp-1",
    name: "Kim Seoyeon",
    employee_number: "10012",
    kind: "ACQUIRE",
    insurer: "NHIS",
    effective_date: "2026-11-02",
    legal_entity_id: "ent-1",
    workplace_id: "wp-1",
    workplace_name: "Pyeongtaek Plant",
    due_date: "2026-11-16",
    due_in_days: 5,
    deadline_status: "CHECKED",
    version: 1,
    completed_on: null,
    receipt_number: null,
    loss_code: null,
    detail: null,
    opens_on: "2026-11-02",
    target_on: "2026-11-16",
    due_on: "2026-11-16",
    dates: null,
    basis: null,
    applicability: { status: "APPLIES" },
    applicability_facts: {},
    can_record_sensitive_facts: true,
    birth_date_known: true,
    state: "PENDING",
    record_action: null,
    not_applicable_reason: null,
    not_applicable_options: [],
    total_remuneration_won: 3_800_000,
    is_request: false,
    acquired_on: "2026-11-02",
    loss_options: [],
    ...overrides,
  };
}

describe("buildStatutoryEdiCsv", () => {
  it("filters out LEGAL_REVIEW and NOT_APPLICABLE tasks and keeps only PENDING rows", () => {
    const pending = makeTask({ event_id: "evt-1", state: "PENDING" });
    const held = makeTask({ event_id: "evt-2", name: "Held Worker", state: "LEGAL_REVIEW" });
    const exempt = makeTask({ event_id: "evt-3", name: "Exempt Worker", state: "NOT_APPLICABLE" });
    const done = makeTask({ event_id: "evt-4", name: "Done Worker", state: "DONE" });

    expect(isEdiEligible(pending)).toBe(true);
    expect(isEdiEligible(held)).toBe(false);
    expect(isEdiEligible(exempt)).toBe(false);
    expect(isEdiEligible(done)).toBe(false);

    const csv = buildStatutoryEdiCsv([pending, held, exempt, done]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("Kim Seoyeon");
    expect(csv).not.toContain("Held Worker");
    expect(csv).not.toContain("Exempt Worker");
    expect(csv).not.toContain("Done Worker");
  });

  it("neutralizes spreadsheet formulas and excludes raw RRN/bank account columns", () => {
    const formulaTask = makeTask({
      name: "=CMD('calc')",
      detail: "+SUM(A1:A2)",
      workplace_name: "@evil",
      employee_number: "-1234",
      loss_code: "11",
    });

    const csv = buildStatutoryEdiCsv([formulaTask]);
    expect(csv).toContain("'=CMD('calc')");
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain("'@evil");
    expect(csv).toContain("'-1234");
    const header = csv.replace("\uFEFF", "").split("\r\n")[0] ?? "";
    expect(header).not.toMatch(/rrn|account|ssn|bank/i);
  });

  it("throws an explicit error when no eligible PENDING filings exist", () => {
    const held = makeTask({ event_id: "evt-2", state: "LEGAL_REVIEW" });
    const exempt = makeTask({ event_id: "evt-3", state: "NOT_APPLICABLE" });
    const done = makeTask({ event_id: "evt-4", state: "DONE" });

    expect(() => buildStatutoryEdiCsv([])).toThrow("No eligible PENDING filings for EDI export");
    expect(() => buildStatutoryEdiCsv([held, exempt, done])).toThrow("No eligible PENDING filings for EDI export");
  });
});
