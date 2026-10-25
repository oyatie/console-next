// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { RenewalFields } from "./lifecycle-renewal";
import { ExitGuardFields } from "./exit-notice";
import { useCard } from "./use-card";
import { NoticePayFact } from "./exit-notice-pay";
import { CommandError } from "../../../lib/react/command-error";
import { peopleRefusal } from "../present";
import { FactsCard } from "./facts-card";
import { ProtectedPeriods } from "./exit-protection";
import { LeaveProtection } from "./legal-preflight";
import { CaseFacts } from "./exit-facts";

const queries = vi.hoisted(() => ({ reads: [] as { fixture?: string; enabled?: boolean; end?: string }[], exceptions: true }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (q: { fixture?: string; enabled?: boolean }) => {
    queries.reads.push(q);
    const path = q.fixture;
    return { isPending: false, data: path === "fixed-term"
      ? { applies: true, cumulative_days: 301, two_year_date: "2027-12-26", basis: "CONTRACT_HISTORY", rule: { value: 5 }, available_exceptions: queries.exceptions ? [{ id: "recorded-exception", ground_code: "OLDER_WORKER", basis: "기간제법 제4조제1항제4호", note: "합성 근거" }] : [] }
      : { items: [], phase: "OPERATING" } };
  },
}));
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  fixedTermQuery: (_id: string, end?: string) => ({ fixture: "fixed-term", end }),
  factsQuery: () => ({ fixture: "employment-facts" }),
}));
vi.mock("../api/record", async (original) => ({
  ...await original<typeof import("../api/record")>(),
  personalFactsQuery: () => ({ fixture: "personal-facts" }),
  registerFactsQuery: () => ({ fixture: "register-facts" }),
  recordsQuery: () => ({ fixture: "records" }),
}));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => true }));

const noop = () => undefined;
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { queries.reads = []; queries.exceptions = true; });

test("renewal keeps a crossing choice visible with its register value and offers each resolution", () => {
  const html = renderToStaticMarkup(<RenewalFields employeeId="person" contractEnd="2026-10-28" start="2026-10-29" today="2026-10-23" bounds={{}} end="2028-10-28" onEnd={noop} onPeriod={noop} onConvert={noop} onNoRenewal={noop} onException={noop} />);
  const reason = t("lifecycle.fixedTerm.over", { years: 5, date: fmtDate("2027-12-26") });
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const period = (years: number, end: string) => t("lifecycle.renewal.period", { years, start: fmtDate("2026-10-29"), end: fmtDate(end) });
  const crossing = buttons.find((button) => button.includes(period(2, "2028-10-28")));
  expect(crossing).toContain('aria-disabled="true"');
  expect(crossing).toContain(reason);
  const within = buttons.find((button) => button.includes(period(1, "2027-10-28")));
  expect(within).toBeDefined();
  expect(within).not.toContain('aria-disabled="true"');
  for (const key of ["convert", "noRenewal", "exception"] as const) {
    expect(html).toContain(t(`lifecycle.fixedTerm.${key}`));
  }
  expect(html).toContain(t("lifecycle.fixedTerm.limit", { years: 5, date: fmtDate("2027-12-26") }));
});

test("renewal offers registered exceptions by ground and basis without a raw identifier field", () => {
  const html = renderToStaticMarkup(<RenewalFields employeeId="person" contractEnd="2026-10-28" start="2026-10-29" today="2026-10-23" bounds={{}} end="2028-10-28" onEnd={noop} onPeriod={noop} exceptionId="recorded-exception" onException={noop} />);
  expect(html).toContain('<select');
  expect(html).toContain(t("lifecycle.fixedTerm.ground.OLDER_WORKER"));
  expect(html).toContain("기간제법 제4조제1항제4호");
  expect(html).toContain("합성 근거");
  expect(html).not.toContain('>recorded-exception<');
});

test("renewal alternatives wait until the chosen end exceeds the registered limit", () => {
  const html = renderToStaticMarkup(<RenewalFields employeeId="person" start="2026-10-29" contractEnd="2026-10-28" today="2026-10-23" bounds={{}} end="2027-10-28" onEnd={noop} onPeriod={noop} onConvert={noop} onNoRenewal={noop} />);
  for (const key of ["convert", "noRenewal", "exception"] as const) expect(html).not.toContain(t(`lifecycle.fixedTerm.${key}`));
});

test("a crossing renewal reads available exceptions before offering the exception action", () => {
  queries.exceptions = false;
  const html = renderToStaticMarkup(<RenewalFields employeeId="person" contractEnd="2026-10-28" start="2026-10-29" today="2026-10-23" bounds={{}} end="2028-10-28" onEnd={noop} onPeriod={noop} onConvert={noop} onNoRenewal={noop} />);
  expect(queries.reads.find((q) => q.end === "2028-10-28")).toMatchObject({ enabled: true });
  expect(html).not.toContain(`>${t("lifecycle.fixedTerm.exception")}</button>`);
  expect(html).toContain(t("lifecycle.fixedTerm.convert"));
  expect(html).toContain(t("lifecycle.fixedTerm.noRenewal"));
});

test.each(["ACTIVE", "EXITED"])("a manager keeps full %s record reads while editability follows employee state", (status) => {
  const detail = { employee: { id: "person", status, company: "회사" } } as Parameters<typeof useCard>[0];
  function CardProbe() {
    const card = useCard(detail);
    return <output data-editable={card.editable} data-manage={card.manage} data-readable={card.readable} />;
  }
  const html = renderToStaticMarkup(<CardProbe />);
  expect(html).toContain(`data-editable="${status !== "EXITED"}"`);
  expect(html).toContain('data-manage="true"');
  expect(html).toContain('data-readable="true"');
  for (const suffix of ["personal-facts", "register-facts", "employment-facts", "records"]) {
    const query = queries.reads.find((q) => q.fixture === suffix);
    expect(query, suffix).toBeDefined();
    expect(query?.enabled, suffix).toBe(true);
  }
});

test("read-only employment facts keep their read surface without edit or probation commands", () => {
  const html = renderToStaticMarkup(<FactsCard e={{ id: "person", name: "퇴직직원" } as Parameters<typeof FactsCard>[0]["e"]} editing={false} onEdit={noop} readOnly />);
  expect(html).toContain(t("facts.title"));
  expect(html).not.toContain(t("facts.edit"));
  expect(html).not.toContain(t("facts.probation.confirm"));
});

type GuardProps = ComponentProps<typeof ExitGuardFields>;
const rule = {
  code: "DISMISSAL_NOTICE_DAYS", value: 30, unit: "DAYS", instrument: "근로기준법", article: "제26조",
  source_url: "https://www.law.go.kr/법령/근로기준법", retrieved_on: "2026-10-21", provenance: "synthetic fixture",
  release_disposition: "HOLD", exception_grounds: [],
};
const pay: NonNullable<GuardProps["pay"]> = {
  owed: true, notice_days: 14, required_days: rule.value, gap_days: 16, rule,
  minimum_service_rule: { ...rule, code: "DISMISSAL_NOTICE_MIN_SERVICE_MONTHS", value: 3, unit: "MONTHS", article: "제26조 단서", exception_grounds: [{ code: "UNAVOIDABLE_CLOSURE", label_ko: "합성 단서" }] },
  amount_won: null, unavailable_reason: "ordinary_wage_missing",
};

test("a refusal's protected period keeps its citation as plain text under the outer disclosure", () => {
  const period = { lifecycle_event_id: "leave", leave_type: "CHILDCARE", leave_from: "2026-10-01", leave_until: null, protected_until: null, instrument: "남녀고용평등법", article: "제19조제3항", rule };
  const html = renderToStaticMarkup(<details><summary>{t("exit.refusal.details")}</summary><ProtectedPeriods periods={[period]} disclose={false} /></details>);
  expect(html.match(/<summary>/g)).toHaveLength(1);
  expect(html).toContain("제19조제3항");
  expect(html).toContain(rule.article);
  expect(html).toContain(rule.provenance);
});
const guardProps: GuardProps = {
  c: { effective_exit_date: "2026-11-06", exit_reason_code: "DISCIPLINARY_DISMISSAL", protected_periods: [] } as unknown as GuardProps["c"],
  reason: "DISCIPLINARY_DISMISSAL", onReason: noop, involuntary: true, noticeRequired: true,
  value: { reason_text: "서면 사유", served_on: "2026-10-23", method: "CERTIFIED_MAIL", evidence_ref: "fixture-receipt" },
  onChange: noop, tried: false, pay, onDisposition: noop,
};

test("confirmation leaves notice pay to its live preflight while the saved case keeps the fact", () => {
  const c = { ...guardProps.c, reported_at: "2026-10-23T09:00:00Z", notice_pay: pay };
  expect(renderToStaticMarkup(<CaseFacts c={c} full />)).not.toContain(t("exit.noticePay.owed"));
  expect(renderToStaticMarkup(<CaseFacts c={c} />)).toContain(t("exit.noticePay.owed"));
});

test("an unprotected leave adds no empty placeholder", () => {
  expect(renderToStaticMarkup(<LeaveProtection unavailable={false} />)).toBe("");
  expect(renderToStaticMarkup(<LeaveProtection unavailable />)).toContain(t("exit.legal.review"));
});

test("short-notice fields require a disposition and show the cited HOLD rule before confirmation", () => {
  const html = renderToStaticMarkup(<ExitGuardFields {...guardProps} />);
  for (const key of ["owed", "disposition", "PAY_IN_LIEU", "REGISTER_EXCEPTION"] as const) {
    expect(html).toContain(t(`exit.noticePay.${key}`));
  }
  expect(html).toContain('aria-required="true"');
  expect(html).toContain("근로기준법 제26조");
  expect(html).toContain(t("exit.legal.review"));
  expect(html).toContain(t("exit.legal.reason"));
  expect(html).toContain(t("exit.noticePay.reason.ordinary_wage_missing"));
});

test("an exception asks for a register ground and evidence beside the same cited rule", () => {
  const html = renderToStaticMarkup(<ExitGuardFields {...guardProps} disposition={{ kind: "REGISTER_EXCEPTION" }} />);
  expect(html).toContain(t("exit.noticePay.ground"));
  expect(html).toContain("합성 단서");
  expect(html).toContain(t("exit.noticePay.evidence"));
  expect(html).toContain("제26조 단서");
});

test.each(["dismissal_notice_short", "employee_exited_read_only", "fixed_term_basis_unconfirmed", "rehire_exit_case_open"] as const)("%s renders the actual Korean rule with its support reference", async (code) => {
  const { ApiError } = await vi.importActual<typeof import("@console/api")>("@console/api");
  const error = new ApiError(409, code, "synthetic server refusal", [], undefined, true, [], { supportRef: "synthetic-legal-reference" });
  const html = renderToStaticMarkup(<CommandError error={error} own={peopleRefusal} />);
  expect(html).toContain(t(`exit.error.${code}`));
  expect(html).toContain('data-support-reference="synthetic-legal-reference"');
});

test("a saved statutory proviso is shown as its disposition rather than an unconditional payment", () => {
  const html = renderToStaticMarkup(<NoticePayFact pay={pay} disposition={{ kind: "REGISTER_EXCEPTION", ground_code: "UNAVOIDABLE_CLOSURE", evidence_ref: "synthetic-proviso-evidence" }} />);
  expect(html).toContain(t("exit.noticePay.exceptionApplied"));
  expect(html).toContain("synthetic-proviso-evidence");
  expect(html).not.toContain(t("exit.noticePay.owed"));
});
