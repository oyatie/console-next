// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import type { components } from "@console/api/schema";
import { fmtDate } from "@console/i18n/format";
import { SettlementFigures } from "./exit-facts";
import { SettlementForm } from "./exit-settlement";

vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ isPending: false, error: null }) }));
vi.mock("./use-exit-command", () => ({
  EXIT_INVALIDATES: [], focusFirstInvalid: vi.fn(),
  useExitCommand: () => ({ phase: { kind: "idle" }, locked: false, error: null }),
}));

type Package = components["schemas"]["EmployeeExitSettlementPackage"];
type Case = components["schemas"]["EmployeeExitCase"];
function pkg(reason = "UNDER_SERVICE_YEARS", num = 1, den = 1): Package {
  return {
    id: "package", status: "READY_FOR_APPROVAL", insurance_loss_payload: {}, approval_payload: {},
    generated_at: "2026-10-21T00:00:00Z", certification_status: "UNCERTIFIED_DRAFT",
    missing_source_fields: [], service_days: 1,
    statutory_basis: {
      severance_eligibility: { outcome: "NOT_ELIGIBLE", reason, threshold: { num, den } },
      calculation_references: { rules: [{ code: "SEVERANCE_MIN_SERVICE_YEARS", effective_from: "2026-07-01", citation: { instrument_ko: "검증 법령", article_ko: "검증 조항" } }] },
    },
  };
}
const form = (p: Package, state: Case["exit_event_state"] = "APPLIED") => renderToStaticMarkup(<SettlementForm c={{
  id: "case", employee_id: "person", employee_name: "합성 직원", effective_exit_date: "2026-10-21",
  exit_event_state: state, settlement_package: p,
} as Case} onDone={() => {}} />);
beforeEach(async () => { i18n.set("ko"); await loadCatalog("ko"); });

test.each([
  ["UNDER_SERVICE_YEARS", 2, 1, "근속 2년 미만"],
  ["UNDER_WEEKLY_HOURS", 29, 2, "주 29/2시간 미만"],
])("%s displays the server threshold and dated citation without wage inputs", (reason, num, den, label) => {
  const html = form(pkg(reason, num, den));
  expect(html).toContain(`퇴직금 미해당 (${label})`);
  expect(html).toContain("노무사 검토 전");
  expect(html).toContain("검증 법령");
  expect(html).toContain("검증 조항");
  expect(html).toContain(fmtDate("2026-07-01"));
  expect(html).not.toContain('type="text"');
  expect(html).not.toContain('aria-disabled="true"');
});

test.each(["OPEN", "FUTURE_OUTCOME"])("%s cannot bypass wage evidence using a stale amount", (outcome) => {
  const p = pkg();
  p.statutory_basis = { severance_eligibility: { outcome } };
  p.severance_pay_won = 3_000_000;
  expect(form(p)).toContain('aria-disabled="true"');
  expect(renderToStaticMarkup(<SettlementFigures pkg={p} />)).not.toContain("3,000,000");
});

test("English renders the recorded reason and counsel review hold", async () => {
  await loadCatalog("en"); i18n.set("en");
  const html = form(pkg("UNDER_WEEKLY_HOURS", 15));
  expect(html).toContain("Severance not applicable (below 15 hours per week)");
  expect(html).toContain("Pending labor counsel review");
});

test.each(["SCHEDULED", "APPLY_FAILED"] as const)("a not applicable decision does not bypass %s", (state) => {
  const html = form(pkg(), state);
  expect(html).toContain("퇴직금 미해당");
  expect(html).toContain('aria-disabled="true"');
});

test("missing sources still block a recorded not applicable decision", () => {
  const p = pkg(); p.missing_source_fields = ["statutory_rules"];
  const html = form(p);
  expect(html).toContain("퇴직금 미해당");
  expect(html).toContain('aria-disabled="true"');
});

test.each([null, "invalid-citation", { code: "invalid-citation", effective_from: "invalid-date", citation: { instrument_ko: "invalid-citation", article_ko: "article" } }])("malformed dated references are not rendered: %j", rule => {
  const p = pkg();
  p.statutory_basis = { ...p.statutory_basis, calculation_references: { rules: [rule] } };
  const html = renderToStaticMarkup(<SettlementFigures pkg={p} />);
  expect(html).not.toContain("invalid-citation");
  expect(html).not.toContain("calculation_references");
});

test("legacy figures and eligible wage inputs retain their existing behavior", () => {
  const p = pkg(); p.statutory_basis = {}; p.severance_pay_won = 3_000_000;
  expect(form(p)).toContain('type="text"');
  expect(form(p)).not.toContain('aria-disabled="true"');
  expect(renderToStaticMarkup(<SettlementFigures pkg={p} />)).toContain("3,000,000");
  p.statutory_basis = { severance_eligibility: { outcome: "ELIGIBLE" } };
  expect(form(p)).toContain('type="text"');
});
