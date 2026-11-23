// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { IMPORT_RUN_STATUS, label } from "../../../lib/labels";
import type { PeopleDataHealthResponse } from "../domain/data-health";
import { DataHealthConsole } from "./data-health-console";

const state = vi.hoisted(() => ({
  health: undefined as PeopleDataHealthResponse | undefined,
  access: { tenant: { hr_basic: "edit" } } as unknown,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <span data-to={to} className={typeof rest.className === "string" ? rest.className : undefined}>{children}</span>
  ),
}));

vi.mock("../../../reference/authz/api", () => ({
  myAccessQuery: { kind: "access" },
}));

vi.mock("../api/data-health", () => ({
  peopleDataHealthQuery: () => ({ kind: "health" }),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: (prev: unknown) => prev,
  useQuery: (opts: { kind?: string }) => {
    if (opts?.kind === "access") {
      return { data: state.access, isPending: false, isSuccess: true, isError: false, error: null, refetch: () => Promise.resolve() };
    }
    return { data: state.health, isPending: false, isSuccess: true, isError: false, error: null, refetch: () => Promise.resolve() };
  },
}));

vi.mock("../../../reference/authz/domain/access", () => ({
  accessRefusal: () => null,
}));

vi.mock("../../../ui/status-bar/status-bar-store", () => ({
  useScreenStatusBar: () => undefined,
}));

beforeAll(() => loadCatalog("ko"));

function makeHealth(status: "PREVIEWED" | "FAILED" | "APPLIED"): PeopleDataHealthResponse {
  return {
    cohort: { total: 2056, active: 2054, on_leave: 1, pre_hire: 1 },
    statutory_register: {
      complete_count: 2050,
      incomplete_count: 6,
      missing_by_category: { birth: 1, job: 1, hire: 1, contract_end: 1, sex: 1, address: 2, career: 1 },
    },
    id_summary: {
      rrn_recorded: 2054,
      not_issued: 1,
      missing: 1,
      by_type: { rrn: 2050, arc: 2, domestic_residence: 2, not_issued: 1, unset: 1 },
    },
    placement_summary: { placed: 2054, unplaced: 1, department_missing: 1 },
    bank_account: { registered: 2055, missing: 1 },
    identity_review: { needs_review: 1 },
    failed_actions: { count: 1 },
    drilldown_items: [
      {
        employee_id: "00000000-0000-4000-8000-000000000001",
        employee_number: "10701",
        employment_status: "PRE_HIRE",
        missing_categories: ["address", "career"],
      },
    ],
    latest_import: {
      run_id: "00000000-0000-4000-8990-000000000001",
      status,
      candidate_rows: 18,
      created_at: "2026-11-10T01:00:00Z",
      applied_at: status === "APPLIED" ? "2026-11-10T01:05:00Z" : undefined,
    },
  };
}

beforeEach(() => {
  state.health = makeHealth("APPLIED");
});

test.each(["PREVIEWED", "FAILED"] as const)("latest_import banner maps %s via IMPORT_RUN_STATUS without exposing raw i18n keys", (status) => {
  state.health = makeHealth(status);
  const html = renderToStaticMarkup(<DataHealthConsole />);
  expect(html).not.toContain(`import.status.${status}`);
  expect(html).toContain(label(IMPORT_RUN_STATUS, status));
});

test("completeness table never shows 100% when missing > 0 and formats header date in ISO form", () => {
  state.health = makeHealth("APPLIED");
  const html = renderToStaticMarkup(<DataHealthConsole />);
  expect(html).not.toContain("100%");
  expect(html).toContain("99%");
  expect(html).toContain(t("dataHealth.asOf", { date: "" }).trim());
  expect(html).toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(html).toContain(t("dataHealth.worklist.openCard"));
});
