// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ApiError } from "../../../reference/statutory/api";
import { CommandError } from "../../../lib/react/command-error";
import { FilingList } from "./filing-list";

const query = vi.hoisted(() => ({ data: { items: [] as unknown[], total: 1, pending: 1, next: null }, isPending: false, isError: false, isSuccess: true, error: null, refetch: vi.fn() }));
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<typeof import("@tanstack/react-query")>(), useQuery: () => query }));
vi.mock("../../../lib/react/command", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/react/command")>(),
  useCommand: () => ({ isPending: false, error: null, mutate: vi.fn() }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: React.ReactNode }) => createElement("span", {}, children) };
});
beforeAll(() => loadCatalog("ko"));

test.each(["LEGAL_REVIEW", "PENDING"])("%s exposes only the available filing controls", (state) => {
  query.data.items = [{
    event_id: "event-1", employee_id: "employee-1", kind: "CHANGE", insurer: "NPS", name: "홍길동",
    state, effective_date: "2026-10-24", due_date: null, due_in_days: null, deadline_status: "UNKNOWN", lifecycle_case_id: "case-1",
  }];
  const html = renderToStaticMarkup(<FilingList workplaces={query} />);
  expect(html).toContain(t("lifecycle.trail.openCase"));
  if (state === "LEGAL_REVIEW") {
    expect(html).toContain("법무 검토 전");
    expect(html).not.toContain(t("statutory.record"));
    expect(html).not.toContain(t("statutory.undo"));
  } else {
    expect(html).toContain(t("statutory.record"));
  }
});

test("a draft-rule refusal explains legal review instead of requesting applicability facts", () => {
  const html = renderToStaticMarkup(<CommandError error={new ApiError(422, "filing_rule_unverified", "unsafe fallback", [], undefined, true)} />);
  expect(html).toContain(t("common.failed.code.filing_rule_unverified"));
  expect(html).not.toContain("unsafe fallback");
});
