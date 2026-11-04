// SPDX-License-Identifier: LicenseRef-Proprietary

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { i18n, loadCatalog, t } from "@console/i18n";
import { inboxFilter } from "../domain/inbox-filter";
import { GroupedQueue } from "./grouped-queue";

beforeAll(() => loadCatalog("ko"));
type Item = components["schemas"]["ActionInboxItem"] & { age_days?: number | null };
const item = (id: string, extra: Partial<Item> & { fold_key?: string } = {}): Item => ({ id, kind: "register_review", lane: "turn", title: id, ref: "", urg: "wait", dueTone: "neutral", done: false, days_remaining: null, links: [{ kind: "employee", id }], ...extra });
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
const html = (items: Item[]) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RouterContextProvider router={router}><GroupedQueue items={items} /></RouterContextProvider></QueryClientProvider>);

test("deadline groups put the D-day exit before undated reviews in the server item set", () => {
  const items = [
    item("undated review", { links: [] }),
    item("later", { due: "2026-11-01T00:00:00Z", days_remaining: 9 }),
    item("D-day exit", { kind: "hr_exit_confirm", due: "2026-10-23T00:00:00Z", days_remaining: 0, dueTone: "danger", who: "김담당", links: [{ kind: "exit_case", id: "exit" }] }),
    item("overdue", { due: "2026-10-22T00:00:00Z", days_remaining: -1 }),
  ];
  const markup = html(items);
  for (const [before, after] of [["overdue", "D-day exit"], ["D-day exit", "later"], ["later", "undated review"]])
    expect(markup.indexOf(before!)).toBeLessThan(markup.indexOf(after!));
  for (const heading of ["기한 지남", "기한 임박", "그 뒤", "기한 없음"])
    expect(markup).toContain(`>${heading}</h3>`);
  expect(markup.match(/<table\b/g)).toHaveLength(4);
  const table = (group: string) => {
    const start = markup.indexOf(`>${group}</h3>`);
    return markup.slice(start, markup.indexOf("</table>", start));
  };
  const groups = ["기한 지남", "기한 임박", "그 뒤", "기한 없음"];
  for (const group of groups)
    for (const heading of ["할 일", "대상", "출처"])
      expect(table(group)).toContain(`>${heading}</th>`);
  for (const group of groups.slice(0, 3)) {
    expect(table(group)).toContain(">기한</th>");
    expect(table(group)).toContain(">업무 처리</span>");
  }
  expect(table("기한 없음")).not.toContain(">기한</th>");
  expect(table("기한 없음")).not.toContain(">업무 처리</span>");
  expect(table("기한 임박")).toContain(">담당</th>");
  for (const group of ["기한 지남", "그 뒤", "기한 없음"])
    expect(table(group)).not.toContain(">담당</th>");
});

test("one subject node per item, and only registered records get an action", () => {
  const markup = html([
    item("한 번만 표시"), item("링크 없음", { links: [] }),
    item("미지원 링크", { links: [{ kind: "approval_run", id: "unregistered" }] }),
    item("잘못된 등록 링크", { links: [{ kind: "registration_check", id: "missing-registration-id" }] }),
  ]);
  expect(markup.match(/>한 번만 표시</g)).toHaveLength(1);
  for (const title of ["링크 없음", "미지원 링크", "잘못된 등록 링크"])
    expect(markup).not.toContain(`aria-label="${title} 작업"`);
});

test("each deadline group ranks source dates before server insertion order", () => {
  const markup = html([
    item("undated first"),
    item("due in three days", { due: "2026-10-29T00:00:00Z", days_remaining: 3, dueTone: "warn" }),
    item("later overdue", { due: "2026-10-25T00:00:00Z", days_remaining: -1, dueTone: "danger" }),
    item("D-day exit", { kind: "hr_exit_confirm", due: "2026-10-26T09:00:00+09:00", days_remaining: 0, dueTone: "danger" }),
    item("earlier overdue", { due: "2026-10-24T00:00:00Z", days_remaining: -2, dueTone: "danger" }),
    item("earlier today", { due: "2026-10-25T23:00:00Z", days_remaining: 0, dueTone: "danger" }),
  ]);
  const ordered = ["earlier overdue", "later overdue", "earlier today", "D-day exit", "due in three days", "undated first"];
  const positions = ordered.map(id => markup.indexOf(`data-id="${id}"`));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test("every record action is quiet rather than a primary row action", () => {
  const items = [
    item("register"),
    item("exit", { kind: "hr_exit_confirm", links: [{ kind: "exit_case", id: "exit" }] }),
    item("draft", { kind: "org_change_draft", links: [{ kind: "org_change", id: "draft" }] }),
    item("grant", { kind: "grant_notice", links: [{ kind: "access", id: "grant" }] }),
  ];
  expect(html(items)).not.toContain("btn--primary");
  expect(html(items)).not.toContain("담당 정보 없음");
});

test("a row states why it needs attention, its age, and a resolving action", () => {
  const markup = html([item("김계약", {
    kind: "contract_renewal", age_days: 12,
  })]);
  expect(markup).not.toContain("계약 만료가 다가옵니다");
  expect(markup).toContain("12일째 대기");
  expect(markup).toContain(">계약 조건 확인</a>");
  expect(markup).not.toContain(">계약 갱신</a>");
});

test("the full inbox defaults to all while my turn remains addressable, and register gaps separate their chips", () => {
  expect(inboxFilter(undefined)).toBe("all");
  expect(inboxFilter("turn")).toBe("turn");
  const markup = html([item("register", { context: { register: { missing_fields: ["birth", "hire", "contractEnd"] } } })]);
  const visible = markup.match(/<tbody>.*?<\/tbody>/s)![0].split(/<[^>]*>/).join("");
  expect(visible).toContain(`${t("empCard.reg.item.birth")} ${t("empCard.reg.item.contract")}`);
  expect(markup.match(new RegExp(`>${t("empCard.reg.item.contract")}<`, "g"))).toHaveLength(1);
});

test.each([
  ["identifier_correction_waiting", "PENDING", "정정 요청 · 사후 검토 확인", "waiting"],
  ["identifier_correction_decide", "PENDING", "정정 요청 검토", "turn"],
  ["identifier_correction_apply", "APPROVED", "승인된 정정 적용", "turn"],
  ["identifier_correction_review", "RECORDED", "사후 검토 기록", "turn"],
] as const)("queue renders labelled correction context and its record verb for %s", (kind, status, verb, lane) => {
  const markup = html([item("correction", { kind, lane, title: "번호검토주식회사", who: "김요청", links: [{ kind: "identifier_correction", id: "case" }], context: { correction: { status } } })]);
  for (const part of ["번호검토주식회사", "요청자: 김요청", "처리 상태: " + t(`entityRecord.corrections.status.${status}`), verb, 'href="/org/entities?correction=case#identifier-corrections"']) expect(markup).toContain(part);
  expect(markup).not.toContain(`<strong>${t("home.inbox.unknown")}</strong>`);
});

test("the queue omits columns with no painted facts or actions", () => {
  const sparse = html([item("sparse", { links: [] })]);
  for (const heading of ["기한", "담당", "업무 처리"])
    expect(sparse).not.toContain(`>${heading}<`);
  for (const heading of ["할 일", "대상", "출처"])
    expect(sparse).toContain(`>${heading}<`);

  const complete = html([item("complete", { due: "2026-10-26T00:00:00Z", days_remaining: 3, who: "김담당" })]);
  for (const heading of ["기한", "담당", "업무 처리"])
    expect(complete).toContain(`>${heading}<`);
});

test("only server fold identities combine rows, keeping deadline and kind boundaries", () => {
  const items = [
    item("first filing", { kind: "insurance_filing", fold_key: "insurance:person:case" }),
    item("second filing", { kind: "insurance_filing", fold_key: "insurance:person:case" }),
    item("person-a", { title: "같은 이름", fold_key: "person:a" }), item("person-b", { title: "같은 이름", fold_key: "person:b" }),
    item("another deadline", { kind: "insurance_filing", fold_key: "insurance:person:case", due: "2026-10-26T00:00:00Z", days_remaining: 0 }),
  ];
  const markup = html(items);
  expect(markup.match(/<tr data-id=/g)).toHaveLength(4);
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("4대보험 신고 · 2건");
  expect(markup).not.toContain("second filing");
});

for (const locale of ["ko", "en"] as const) test(`row reasons add state without repeating the ${locale} task title`, async () => {
  await loadCatalog(locale);
  i18n.set(locale);
  try {
    for (const kind of ["identifier_correction_waiting", "identifier_correction_decide", "identifier_correction_apply", "identifier_correction_review", "approval", "org_change_waiting", "org_change_scheduled", "org_change_approve", "org_change_apply", "org_change_draft", "org_change_rejected", "org_change_settle", "hr_exit_confirm", "hr_exit_confirm_hq", "hr_exit_settle", "hr_request", "period_unlock"])
      expect(html([item(kind, { kind, links: [] })])).toContain(t(`home.inbox.reason.${kind}` as Parameters<typeof t>[0]));
    for (const kind of ["registration_check", "support_access", "org_change", "hr_exit", "hr_lifecycle", "lifecycle_apply_failed", "register_review", "identity_review", "unplaced", "insurance_filing", "grant_notice", "dispatch", "support", "work", "payroll", "governance", "unknown"])
      expect(html([item(kind, { kind, links: [] })]).split("</td>")[0]).not.toContain('class="muted"');
    expect(html([item("future", { kind: "future_kind" })]).split("</td>")[0]).not.toContain('class="muted"');
    expect(html([item("undated", { kind: "contract_renewal" })])).not.toContain(t("home.inbox.reason.contract_renewal"));
    const markup = html([item("contract", { kind: "contract_renewal", due: "2026-11-01T00:00:00Z", context: { reason: "<추가 사유>" } })]);
    expect(markup).toContain(t("home.inbox.reason.contract_renewal"));
    expect(markup).toContain("&lt;추가 사유&gt;");
    expect(markup).not.toContain("<추가 사유>");
  } finally { i18n.set("ko"); }
});

const taskCell = (markup: string) => markup.match(/<td\b[^>]*>(.*?)<\/td>/s)![1]!;

test.each(["대상 제목", "명부 항목 빠짐"])("context reason omits a repeated row title: %s", reason => {
  const markup = html([item("대상 제목", { context: { reason } })]);
  expect(taskCell(markup).split(reason)).toHaveLength(reason === "대상 제목" ? 1 : 2);
});

test("identical state and context reasons appear once, and never repeat the subject", () => {
  const reason = t("home.inbox.reason.approval");
  expect(html([item("approval", { kind: "approval", context: { reason } })]).split("</td>")[0]!.match(new RegExp(reason, "g"))).toHaveLength(1);
  expect(taskCell(html([item(reason, { kind: "approval", context: { reason } })]))).not.toContain(reason);
});
