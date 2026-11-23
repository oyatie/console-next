// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useQueries } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { EmployeeWarnings } from "./employee-warnings";

type Warning = components["schemas"]["EmployeeCreateWarning"];

vi.mock("@tanstack/react-query", () => ({
  useQueries: vi.fn(() => []),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: ReactNode; params?: { id?: string } }) => (
    <span data-link={params?.id}>{children}</span>
  ),
}));

beforeAll(() => loadCatalog("ko"));

beforeEach(() => {
  vi.mocked(useQueries).mockReset().mockReturnValue([]);
});

test("renders server-supplied matches without N+1 employee queries", () => {
  const warnings: Warning[] = [
    {
      code: "same_name_in_unit",
      employee_ids: ["emp-1", "emp-2"],
      matches: [
        { id: "emp-1", name: "Alice Kim", employee_number: "1001" },
        { id: "emp-2", name: "Alice Kim", employee_number: undefined },
      ],
      total_count: 2,
    },
  ];
  const html = renderToStaticMarkup(<EmployeeWarnings warnings={warnings} />);
  expect(useQueries).not.toHaveBeenCalled();
  expect(html).toContain('data-link="emp-1"');
  expect(html).toContain("Alice Kim (1001)");
  expect(html).toContain('data-link="emp-2"');
  expect(html).toContain("Alice Kim (—)");
  expect(html).not.toContain(t("people.sameName.loading"));
});

test("renders overflow count when total_count exceeds returned matches", () => {
  const warnings: Warning[] = [
    {
      code: "same_name_same_hire_date",
      employee_ids: ["emp-1"],
      matches: [{ id: "emp-1", name: "Bob Park", employee_number: "1009" }],
      total_count: 25,
    },
  ];
  const html = renderToStaticMarkup(<EmployeeWarnings warnings={warnings} />);
  expect(useQueries).not.toHaveBeenCalled();
  expect(html).toContain("Bob Park (1009)");
  expect(html).toContain(`<bdi>${t("people.sameName.more", { count: 24 })}</bdi>`);
});

test("falls back to employee_ids queries only when matches are omitted", () => {
  vi.mocked(useQueries).mockReturnValueOnce([
    { data: { employee: { id: "emp-3", name: "Charlie Lee", employee_number: "1015" } } },
    { data: undefined },
  ] as unknown as ReturnType<typeof useQueries>);
  const warnings: Warning[] = [
    {
      code: "same_name_in_unit",
      employee_ids: ["emp-3", "emp-4"],
    },
  ];
  const html = renderToStaticMarkup(<EmployeeWarnings warnings={warnings} />);
  expect(useQueries).toHaveBeenCalledTimes(1);
  expect(html).toContain("Charlie Lee (1015)");
  expect(html).toContain(t("people.sameName.loading"));
});

test("renders pay_below_minimum_wage without triggering namesake queries", () => {
  const warnings: Warning[] = [
    {
      code: "pay_below_minimum_wage",
      employee_ids: [],
      floor_won: 2096270,
    },
  ];
  const html = renderToStaticMarkup(<EmployeeWarnings warnings={warnings} />);
  expect(useQueries).not.toHaveBeenCalled();
  expect(html).toContain(t("people.warning.pay.title"));
  expect(html).toContain("2,096,270");
});
