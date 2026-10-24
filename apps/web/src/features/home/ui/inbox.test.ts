// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, type MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { components } from "@console/api/schema";
import type { Checklist } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import type { Button } from "../../../ui/button/button";
import { Home } from "../Home";
import { cursorPages, readIdentity } from "../../../lib/query";

type Item = components["schemas"]["ActionInboxItem"];
type Page = components["schemas"]["ActionInboxResponse"];
type Options = ReturnType<typeof cursorPages<"/api/v1/me/action-inbox">>;
const view = vi.hoisted(() => ({
  get: vi.fn(), filter: "turn", reads: [] as string[], options: undefined as Options | undefined,
  buttons: [] as Parameters<typeof Button>[0][], next: vi.fn(), retry: vi.fn(),
  list: { isPending: false, error: null as unknown, data: undefined as { pages: Page[] } | undefined, hasNextPage: false, isFetchingNextPage: false },
}));
vi.mock("@console/api", async (original) => {
  const actual = await original<typeof import("@console/api")>();
  return { ...actual, api: { ...actual.api, GET: (...args: unknown[]) => view.get(...args) } };
});
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => initial === "turn" ? [view.filter, (filter: string) => { view.filter = filter; }] : actual.useState(initial) };
});
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (options: Parameters<typeof readIdentity>[0]) => {
    view.reads.push(String(JSON.parse(readIdentity(options))[0]));
    return { data: JSON.parse(readIdentity(options))[0] === "/api/v1/branches" ? [] : { display_name: "사용자", capabilities: [], items: [], is_ops: true }, isPending: false, isFetching: false, isError: false, isSuccess: true, dataUpdatedAt: 1 };
  },
  useQueries: ({ queries }: { queries: Parameters<typeof readIdentity>[0][] }) => queries.map((query) => {
    view.reads.push(String(JSON.parse(readIdentity(query))[0]));
    return { data: { items: [], total: 0 }, isPending: false, isFetching: false, isError: false, isSuccess: true, dataUpdatedAt: 1 };
  }),
  useInfiniteQuery: (options: Options) => { view.options = options; return { ...view.list, fetchNextPage: view.next, refetch: view.retry }; },
}));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({}) }));
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (props: Parameters<typeof Button>[0]) => { view.buttons.push(props); return createElement(actual.Button, props); } };
});
const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, kind: "register_review", lane: "turn", title: id, ref: "", urg: "wait", dueTone: "neutral", done: false, days_remaining: null, links: [{ kind: "employee", id }], ...extra });
const page = (items: Item[], extra: Partial<Page> = {}): Page => ({ items, total: items.length, total_is_exact: true, next_cursor: null, unavailable: [], available_filters: ["turn", "waiting", "scheduled", "deadlines", "failures"], counts: {}, upcoming: [], has_work: true, quick_starts: [], as_of: "2026-10-23T00:00:00Z", ...extra });
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
const html = (setupPending = false) => renderToStaticMarkup(createElement(RouterContextProvider, { router } as Parameters<typeof RouterContextProvider>[0], createElement(() => Home({ setupPending, setup: (c: Checklist) => createElement("div", { "data-testid": "inbox-setup" }, c.total), action: (row: Item) => row.context?.command ? createElement("button", { "data-command": row.context.command, "data-record": row.links[0]?.id }, row.context.command) : row.kind === "account_security" ? createElement("button", null, t("account.second.add")) : null }))));
const click = (label: string) => view.buttons.find((button) => button.children === label || typeof button.children === "string" && button.children.startsWith(label + " "))!.onClick!({} as MouseEvent<HTMLButtonElement>);
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  view.filter = "turn"; view.reads = []; view.options = undefined; view.buttons = [];
  view.list = { isPending: false, error: null, data: { pages: [page([item("명부 확인")])] }, hasNextPage: false, isFetchingNextPage: false };
});

test("Home reads all work through the unified inbox and renders its record verb", () => {
  const markup = html();
  expect(JSON.parse(readIdentity(view.options!))).toEqual(["/api/v1/me/action-inbox", { query: { filter: "turn" } }, "cursor"]);
  expect(view.reads.filter((path) => path !== "/api/v1/users/me")).toEqual([]);
  expect(markup).toContain("명부 확인");
  expect(markup).toContain('href="/people/');
  expect(markup).toContain(t("home.inbox.reason.register"));
  expect(view.options).toMatchObject({ refetchOnMount: "always" });
});

test.each([
  ["period_unlock", "period_lock", { unlock: { domain: "payroll", periodStart: "2026-09-01", periodEnd: "2026-09-30", requester: "김요청", reason_code: "RETRO_CORRECTION" } }, ["급여", "2026년 9월", "김요청", "소급 정정", "급여 2026년 9월 해제 요청 검토"]],
  ["period_unlock", "period_lock", { unlock: { domain: "payroll", periodStart: "2026-09-01", periodEnd: "2026-09-30", requester: "김요청", reason_code: "T_0123456789ABCDEF0123456789ABCDEF", reason_entry: { system: false, label_ko: "추가 정산", label_en: null } } }, ["추가 정산", "급여 2026년 9월 해제 요청 검토"]],
  ["period_unlock", "period_lock", { unlock: { domain: "payroll", periodStart: "2026-09-01", periodEnd: "2026-09-30", requester: "김요청", reason_code: "FUTURE_REASON" } }, ["확인되지 않은 항목"]],
  ["insurance_filing", "statutory", { insurance: { insurer: "EI", kind: "ACQUIRE", effective_date: "2026-09-01" } }, ["고용보험", "취득 신고", "4대보험 신고 열기"]],
  ["lifecycle_apply_failed", "employee", { lifecycle: { action_kind: "TRANSFER", effective_date: "2026-09-01" } }, ["전보", "확인"]],
  ["hr_request", "change_request", { request: { kind: "PROFILE_CORRECTION", reason_code: "DATA_ENTRY_ERROR" } }, ["정보 정정", "입력 오류", "요청 검토"]],
  ["hr_request", "change_request", { request: { kind: "PROFILE_CORRECTION", reason_code: "주소를 확인해 주십시오" } }, ["정보 정정", "주소를 확인해 주십시오", "요청 검토"]],
  ["hr_request", "change_request", { request: { kind: "PROFILE_CORRECTION", reason_code: "FUTURE_REASON" } }, ["확인되지 않은 항목", "요청 검토"]],
] as const)("%s labels source facts and keeps its resolving verb without machine codes", (kind, link, context, labels) => {
  view.list.data = { pages: [page([item("업무 대상", { kind, title: "김직원", links: [{ kind: link, id: "record" }], context })])] };
  const markup = html();
  for (const text of labels) expect(markup).toContain(text);
  const visible = markup.match(/<li class="form">.*?<\/li>/s)![0].split(/<[^>]*>/).join("");
  expect(visible).not.toMatch(/[A-Z]{2,}_?[A-Z]*|payroll/);
});

test.each(["waiting", "scheduled", "deadlines", "failures"] as const)("%s requests the server filter", (filter) => {
  html();
  click(t(`home.inbox.filter.${filter}`));
  html();
  expect(JSON.parse(readIdentity(view.options!))[1]).toEqual({ query: { filter } });
});

test("more work follows the server cursor without an offset or a polling interval", async () => {
  view.list.hasNextPage = true;
  html();
  click(t("home.inbox.more"));
  expect(view.next).toHaveBeenCalledOnce();
  expect(view.options!.getNextPageParam(page([], { next_cursor: "stable-cursor" }))).toBe("stable-cursor");
  const response = page([item("next")]);
  const get = view.get.mockResolvedValue({ data: response, response: new Response() });
  await view.options!.queryFn({ pageParam: "stable-cursor" });
  expect(get).toHaveBeenCalledWith("/api/v1/me/action-inbox", { params: { query: { filter: "turn", cursor: "stable-cursor" } } });
});

test("a refreshed response removes resolved rows and keeps loaded cursor pages", () => {
  view.list.data = { pages: [page([item("resolved")]), page([item("still waiting")])] };
  expect(html()).toContain("resolved");
  view.list.data = { pages: [page([]), page([item("still waiting")])] };
  const refreshed = html();
  expect(refreshed).not.toContain("resolved");
  expect(refreshed).toContain("still waiting");
});

test("deadlines use the server's remaining days", () => {
  view.list.data = { pages: [page([item("dated", { due: "2099-01-01T00:00:00Z", days_remaining: 3, dueTone: "warn" })])] };
  expect(html()).toContain("D-3");
});

test("a statutory inbox item opens the filing list for its own lifecycle event", () => {
  const event = "ecdf082c-c28e-4e9f-b6bb-9c4187d8d6fd";
  view.list.data = { pages: [page([item("신고 대상", { kind: "insurance_filing", links: [{ kind: "statutory", id: event }] })])] };
  expect(html()).toContain(`href="/statutory?event=${event}"`);
});

test("a failed inbox read shows retry without claiming the queue is empty", () => {
  view.list.error = new Error("source unavailable"); view.list.data = undefined;
  const markup = html();
  expect(markup).toContain(t("common.loadFailed.title"));
  expect(markup).not.toContain(t("home.inbox.empty.title"));
  click(t("common.retry"));
  expect(view.retry).toHaveBeenCalledOnce();
});

test("setup work uses its server checklist once inside the inbox", () => {
  const setup: Checklist = { phase: "SETUP", steps: [], done: 0, total: 1, go_live_at: null, summary: { people: 0, placed: 0, unplaced: 0, entity_unknown: 0, progress: 0 } };
  view.list.data = { pages: [page([item("duplicated setup", { kind: "setup_entity" })], { setup })] };
  const markup = html();
  expect(markup.match(/data-testid="inbox-setup"/g)).toHaveLength(1);
  expect(markup).not.toContain("duplicated setup");
  expect(markup.indexOf('id="inbox-title"')).toBeLessThan(markup.indexOf('data-testid="inbox-setup"'));
});

test("Home hides cached setup and work until the parent setup references settle", () => {
  view.list.data = { pages: [page([item("cached work")], { setup: { phase: "SETUP", steps: [], done: 0, total: 1, go_live_at: null, summary: { people: 0, placed: 0, unplaced: 0, entity_unknown: 0, progress: 0 } } })] };
  const pending = html(true);
  expect(pending).toContain(t("common.loading"));
  expect(pending).not.toContain('id="inbox-title"');
  expect(pending).not.toContain('data-testid="inbox-setup"');
  expect(pending).not.toContain("cached work");
  const ready = html(false);
  expect(ready).toContain('id="inbox-title"');
  expect(ready).toContain('data-testid="inbox-setup"');
  expect(ready).toContain("cached work");
});

test("an unregistered record kind stays readable without a guessed destination", () => {
  view.list.data = { pages: [page([item("future work", { links: [{ kind: "future_kind", id: "javascript:bad" }] })])] };
  const markup = html();
  expect(markup).toContain("future work");
  expect(markup).not.toContain("javascript:");
  expect(markup).not.toContain('href="/people/');
});


test("each filter shows its server count and an inexact lower bound", () => {
  view.list.data = { pages: [page([item("work")], { counts: { turn: { total: 7, total_is_exact: true }, waiting: { total: 2, total_is_exact: false } } })] };
  const markup = html();
  expect(markup).toContain(`${t("home.inbox.filter.turn")} 7`);
  expect(markup).toContain(`${t("home.inbox.filter.waiting")} 2+`);
});

test("one failed source keeps healthy rows, names the outage and offers retry with its support reference", () => {
  view.list.data = { pages: [page([item("healthy work")], { total_is_exact: false, unavailable: [{ source: "hr_register", support_reference: "0123456789abcdef0123456789abcdef" }] })] };
  const markup = html();
  expect(markup).toContain("healthy work");
  expect(markup).toContain("0123456789abcdef0123456789abcdef");
  expect(markup).toContain(t("home.review.register"));
  click(t("common.retry"));
  expect(view.retry).toHaveBeenCalledOnce();
});

test("no work grant shows the honest account page without dead filters", () => {
  view.list.data = { pages: [page([], { has_work: false })] };
  const markup = html();
  expect(markup).toContain(t("home.noWork.title"));
  expect(markup).toContain('href="/account"');
  expect(markup).not.toContain('aria-label="'+t("home.lanes")+'"');
});

test("empty turn offers permitted starts, next scheduled work and the as-of stamp", () => {
  view.list.data = { pages: [page([], { quick_starts: ["register", "import", "org", "invite"], upcoming: [item("next change", { kind: "org_change_scheduled", lane: "scheduled", links: [{ kind: "org_change", id: "next" }] })] })] };
  const markup = html();
  for (const key of ["register", "import", "org", "invite"] as const) expect(markup).toContain(t(`home.tiles.${key}`));
  expect(markup).toContain("next change");
  expect(markup).toContain(t("home.next.title"));
  expect(markup).toContain(t("home.asOf", { time: "2026. 10. 23. 오전 9:00" }).split(" ")[0]);
});

test("grant confirmation is preceded by scope, start/end and authority reach", () => {
  view.list.data = { pages: [page([item("grant", { kind: "grant_notice", title: "notice role", links: [{ kind: "access", id: "g" }], context: { grants: [{ grant_id: "g", role_id: "r", role_name_ko: "notice role", domain: "hr_basic", level: "view", scope: { kind: "TENANT", node_id: null, include_descendants: true }, valid_from: "2026-01-01T00:00:00Z", valid_to: "2027-01-01T00:00:00Z", enforcement: "ENFORCED", caveats: [] }] } })])] };
  const markup = html();
  expect(markup).toContain(t("access.scope.tenant"));
  expect(markup).toContain("2026");
  expect(markup).toContain(t("accessCodes.domain.hr_basic"));
  expect(markup.indexOf(t("access.scope.tenant"))).toBeLessThan(markup.indexOf(t("home.grantNotices.confirm", { role: "notice role" })));
});

test("only usable server filters are offered", () => {
  view.list.data = { pages: [page([item("work")], { available_filters: ["turn", "deadlines"] })] };
  const markup = html();
  expect(markup).toContain(t("home.inbox.filter.deadlines"));
  expect(markup).not.toContain(t("home.inbox.filter.waiting"));
  expect(markup).not.toContain(t("home.inbox.filter.failures"));
});

test.each(["approve", "effectuate"] as const)("server command %s reaches the inline control beside the record link", (command) => {
  view.list.data = { pages: [page([item("org", { kind: command === "approve" ? "org_change_approve" : "org_change_apply", links: [{kind:"org_change",id:"record"}], context: { command, drafter:"drafter", reason:"reason" } })])] };
  const markup = html();
  expect(markup).toContain(`data-command="${command}"`);
  expect(markup).toContain('data-record="record"');
  expect(markup).toContain('href="/org/changes/record"');
  expect(markup).toContain("drafter");
  expect(markup).toContain("reason");
});

test("waiting work retains its durable outcome link", () => {
  view.list.data = { pages: [page([item("waiting", { kind:"org_change_waiting",lane:"waiting",context:{command_id:"outcome"} })])] };
  expect(html()).toContain('href="/requests/outcome"');
});


test.each([["identity_review","identity"],["home_branch_review","branch"],["register_review","register"],["lifecycle_apply_failed","failed"]] as const)("%s keeps its filtered-directory entry verb", (kind, review) => {
  view.list.data = { pages: [page([item("work", {kind})])] };
  expect(html()).toContain(`/people?review=${review}`);
});

test("account security retains inline second-passkey registration and account navigation", () => {
  view.list.data = { pages: [page([item("security", {kind:"account_security",links:[{kind:"account",id:"me"}],context:{is_ops:true}})])] };
  const markup = html();
  expect(markup).toContain(t("account.second.add"));
  expect(markup).toContain(t("account.second.whyOps"));
  expect(markup).toContain('href="/account"');
});

test.each([
  ["org_change_draft", "org_change", "/org/changes/record"],
  ["org_change_rejected", "org_change", "/org/changes/record"],
  ["org_change_settle", "org_change", "/org/changes/record"],
  ["org_change_waiting", "org_change", "/org/changes/record"],
  ["org_change_scheduled", "org_change", "/org/changes/record"],
  ["contract_renewal", "employee", "/people/record?act=CONTRACT_RENEWAL"],
  ["hr_request", "change_request", "/people/requests?sel=record"],
  ["hr_exit_confirm", "exit_case", "/people/exits/record?act=confirm_exit"],
  ["hr_exit_confirm_hq", "exit_case", "/people/exits/record?act=confirm_exit_hq"],
  ["hr_exit_settle", "exit_case", "/people/exits/record?act=prepare_settlement"],
  ["period_unlock", "period_lock", "/people/period-locks?review=record"],
] as const)("%s retains its resolving record or sheet verb", (kind, link, href) => {
  view.list.data = { pages: [page([item("work", { kind, links: [{ kind: link, id: "record" }], context: kind === "period_unlock" ? { unlock: { domain: "payroll", periodStart: "2026-09-01", periodEnd: "2026-09-30", requester: "김요청", reason_code: "RETRO_CORRECTION" } } : undefined })])] };
  expect(html()).toContain(`href="${href}"`);
});


test.each([
  ["missing grant", undefined, false],
  ["unnamed workplace", { kind: "WORKPLACE", node_id: "workplace", include_descendants: true }, false],
  ["named workplace", { kind: "WORKPLACE", node_id: "workplace", node_name: "서울본사", include_descendants: true }, true],
  ["tenant", { kind: "TENANT", node_id: null, include_descendants: true }, true],
] as const)("grant confirmation requires disclosed scope: %s", (_name, scope, enabled) => {
  const grants: components["schemas"]["AccessEffectiveEntry"][] = scope ? [{ grant_id: "g", role_id: "r", role_name_ko: "notice role", domain: "hr_basic", level: "view", scope, valid_from: "2026-01-01T00:00:00Z", valid_to: null, enforcement: "ENFORCED", caveats: [] }] : [];
  view.list.data = { pages: [page([item("grant", { kind: "grant_notice", title: "notice role", links: [{ kind: "access", id: "g" }], context: { grants } })])] };
  html();
  const confirm = view.buttons.find((button) => button.children === t("home.grantNotices.confirm", { role: "notice role" }));
  expect(confirm).toBeDefined();
  expect(Boolean(confirm!.disabled)).toBe(!enabled);
});

test("support approvals keep their source label and selected review destination", () => {
  view.list.data = { pages: [page([item("support-approval", { kind: "support_access", title: "조직 조회 오류 확인", ref: "HELP-123", who: "공급사 운영자", links: [{ kind: "support_session", id: "pending-support" }] })])] };
  const markup = html();
  expect(markup).toContain(t("home.part.support"));
  expect(markup).toContain(t("supportAccess.review"));
  expect(markup).toContain('href="/audit/support-access?review=pending-support"');
  for (const fact of ["조직 조회 오류 확인", "HELP-123", "공급사 운영자"]) expect(markup).toContain(fact);
});

test("a failed support-approval source keeps its own retry label", () => {
  view.list.data = { pages: [page([], { unavailable: [{ source: "support_access", support_reference: "support-reference" }] })] };
  const markup = html();
  expect(markup).toContain(t("home.inbox.unavailable", { part: t("home.part.support") }));
  expect(markup).toContain("support-reference");
});
