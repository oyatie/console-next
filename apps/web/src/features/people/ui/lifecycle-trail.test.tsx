// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "../../../reference/statutory/api";
import { loadCatalog, t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import type { CaseItem, LifecycleCase } from "../api/lifecycle-trail";
import { ItemWindow, TrailItems } from "./lifecycle-trail";
import { lifecycleTrailError } from "../present";
import { CaseItemAction } from "./lifecycle-trail-action";

vi.mock("../../../lib/react/command", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/react/command")>(),
  useCommand: () => ({ isPending: false, error: null, mutate: vi.fn() }),
}));

vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, params, search, hash, children }: { to: string; params?: { id: string }; search?: Record<string, string>; hash?: string; children: React.ReactNode }) => createElement("span", { "data-href": to.replace("$id", params?.id ?? "") + (search ? `?${new URLSearchParams(search)}` : "") + (hash ? `#${hash}` : "") }, children) };
});

beforeAll(() => loadCatalog("ko"));

const item = (overrides: Partial<CaseItem> = {}): CaseItem => ({
  id: "item-1", case_id: "case-1", item_key: "document", label: "Synthetic document", label_key: null,
  completion_rule_ref: "LIFECYCLE_ITEM_ATTESTED", waiver_rule_ref: "LIFECYCLE_ITEM_WAIVED",
  kind: "DOC", owner_line: "hr.personal:manage", status: "OPEN", status_code: null,
  opens_on: "2026-10-01", opens_in_days: 0, due_date: null, due_in_days: null, due_disposition: "UNKNOWN",
  due_rule_ref: null, opens_rule_ref: null, basis: {}, blocks_close: true,
  observed_ref: null, exception_id: null, filing_obligation_id: null, filing_kind: null, insurer: null, version: 1,
  ...overrides,
});

const dossier = (items: CaseItem[]): LifecycleCase => ({
  id: "case-1", employee_id: "employee-1", kind: "HIRE", state: "CLOSED", trigger_id: "event-1",
  effective_date: "2026-10-01", linked_case_id: null, cancellation_reason: null, version: 1, items,
});

test("pre-console filings name their insurer and explain the exclusion", () => {
  const html = renderToStaticMarkup(<TrailItems value={dossier([item({ kind: "FIL", filing_kind: "ACQUIRE", insurer: "EI", due_rule_ref: "register-rule-1", status: "NOT_APPLICABLE", status_code: "PRE_CONSOLE" })])} />);
  expect(html).toContain("고용보험 취득 신고");
  expect(html).toContain("운영 시작 전");
  expect(html).not.toContain("미해당");
  expect(html.match(/<time /g)).toHaveLength(1);
  expect(html).not.toContain(t("statutory.unknown"));
});

test.each(["DOC", "REC", "ACC"])("a %s item without a register window shows no missing-deadline warning", (kind) => {
  for (const status of ["OPEN", "DONE_OBSERVED"]) {
    const html = renderToStaticMarkup(<TrailItems value={dossier([item({ kind, status, opens_on: null })])} />);
    expect(html).not.toContain(t("lifecycle.trail.opensUnknown"));
    expect(html).not.toContain(t("statutory.unknown"));
    expect(html).not.toContain(t("statutory.opens"));
  }
});

test("a register rule with an unknown deadline still shows the warning", () => {
  const html = renderToStaticMarkup(<TrailItems value={dossier([item({ due_rule_ref: "register-rule-1", opens_on: null })])} />);
  expect(html).toContain(t("statutory.unknown"));
});

test("filings link to the completion path and evidence is a named linked document", () => {
  const html = renderToStaticMarkup(<TrailItems value={dossier([item({ filing_obligation_id: "filing-1", observed_ref: { document: { name: "입사 계약서", url: "https://files.example/contract.pdf" } } })])} />);
  expect(html).toContain('filing=filing-1');
  expect(html).toContain('href="https://files.example/contract.pdf"');
  expect(html).toContain("입사 계약서");
  expect(html).not.toContain("<code>");
});

test.each([
  "lifecycle.refuse.window_not_open",
  "lifecycle.refuse.self_completion",
  "lifecycle.refuse.owner_line",
  "lifecycle.refuse.evidence_required",
  "lifecycle.refuse.close_blocked",
  "lifecycle.refuse.deadline_unknown",
] as const)("%s renders its Korean refusal without unsafe fallback or success", (code) => {
  const text = lifecycleTrailError(code);
  expect(text).toBe(t(code));
  expect(text).toMatch(/[가-힣]/);
  const html = renderToStaticMarkup(<CommandError error={new ApiError(422, code, "unsafe fallback", [], undefined, true)} own={lifecycleTrailError} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain(text);
  expect(html).not.toContain("unsafe fallback");
  expect(html).not.toContain(t("lifecycle.trail.status.DONE_OBSERVED"));
});

test("an unknown deadline hides a supplied guessed date and countdown", () => {
  const html = renderToStaticMarkup(<ItemWindow item={item({ due_date: "2026-12-31", due_in_days: 99 })} />);
  expect(html).toContain(t("statutory.unknown"));
  expect(html).not.toContain("2026-12-31");
  expect(html).not.toContain("D-99");
  expect(html.replace(/<[^>]*>/g, "")).not.toContain("기한 기한 미확인");
});

test("a future item shows when it starts without a duplicate target", () => {
  const html = renderToStaticMarkup(<ItemWindow item={item({ opens_in_days: 2 })} />);
  expect(html).toContain("2일 후 시작");
  expect(html).toContain(t("statutory.opens"));
  expect(html).toContain(t("statutory.deadline"));
  expect(html).not.toContain(t("statutory.target"));
});

test.each(["HOLD", "UNKNOWN"])("an unverified %s rule retains its citation and legal review state", (due_disposition) => {
  const value = dossier([item({ due_disposition, due_rule_ref: "register-rule-1", basis: { instrument: "Synthetic instrument", article: "Synthetic article", legal_review_required: true } })]);
  const html = renderToStaticMarkup(<TrailItems value={value} />);
  expect(html).toContain("법무 검토 전");
  expect(html).toContain("register-rule-1");
  expect(html).toContain("Synthetic instrument");
  expect(html).toContain("Synthetic article");
  expect(renderToStaticMarkup(<ItemWindow item={value.items[0]!} />)).toContain(t("statutory.hold"));
});

test("a filing row names the scheme and acquisition supplied by the register", () => {
  const value = dossier([item({ kind: "FIL", label_key: "lifecycle.trail.filing", filing_kind: "ACQUIRE", insurer: "NPS" })]);
  const html = renderToStaticMarkup(<TrailItems value={value} />);
  expect(html).toContain("국민연금 취득 신고");
  expect(html).not.toContain("Synthetic document");
});

test("a filing awaiting legal review has no record link or attestation control", () => {
  const value = { ...dossier([item({ kind: "FIL", filing_kind: "CHANGE", insurer: "NPS", filing_obligation_id: "filing-1", status: "BLOCKED", status_code: "LEGAL_REVIEW", basis: { legal_review_required: true }, blocks_close: false })]), state: "OPEN" };
  const html = renderToStaticMarkup(<TrailItems value={value} />);
  expect(html).toContain("법무 검토 전");
  expect(html).not.toContain(t("lifecycle.trail.openFiling"));
  expect(html).not.toContain(t("lifecycle.trail.attest"));
});

test("a waived item shows its retained decision reason", () => {
  const html = renderToStaticMarkup(<TrailItems value={dossier([item({ status: "WAIVED", completion_reason: "확인한 대체 증빙으로 면제" })])} />);
  expect(html).toContain("확인한 대체 증빙으로 면제");
});

test.each([
  { opens_in_days: 2 },
  { status: "PENDING_TRIGGER" },
])("an unopened item %j disables evidence entry and completion", (future) => {
  const html = renderToStaticMarkup(<CaseItemAction caseId="case-1" item={item(future)} />);
  expect(html).toMatch(/<button[^>]*disabled=""/);
  expect(html).not.toContain("<input");
  expect(html).toContain(t("lifecycle.trail.attest"));
});
