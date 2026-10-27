// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { issueNotice, type NoticeCandidate } from "../api";
import { NoticeNewPage } from "./notice-new-page";

const state = vi.hoisted(() => ({
  search: {} as { batch?: string; events?: string; count?: number },
  candidates: [] as NoticeCandidate[],
  error: undefined as unknown,
  readError: undefined as unknown,
  pending: false,
  hasData: true,
  command: undefined as undefined | { run: (input: void, key: string) => Promise<unknown> },
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => state.search, useNavigate: () => vi.fn() }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-to={to}>{children}</span>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ isPending: false, error: null, data: undefined }),
  useInfiniteQuery: () => ({ isError: !!state.readError, data: state.hasData ? { pages: [{ items: state.candidates, next_cursor: null }] } : undefined, isPending: state.pending, error: state.readError, hasNextPage: false, refetch: vi.fn() }),
}));
vi.mock("../../../lib/react/command", async (original) => ({
  ...await original<typeof import("../../../lib/react/command")>(),
  useCommand: (command: typeof state.command) => { state.command = command; return { isPending: false, error: state.error, mutate: vi.fn() }; },
}));
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  issueNotice: vi.fn(async () => ({ id: "notice-made" })),
}));

const candidate = (id: string, name: string, date: string) => ({
  employee_id: `person-${id}`, employee_number: `EMP-${id}`, name,
  event: { id, employee_id: `person-${id}`, event_type: "TRANSFER", state: "SCHEDULED", effective_date: date, from_org_unit: "인사부", to_org_unit: "채용팀" },
}) as NoticeCandidate;
const render = () => renderToStaticMarkup(<NoticeNewPage />);
let ApiError: typeof import("@console/api").ApiError;
beforeAll(async () => { ({ ApiError } = await vi.importActual<typeof import("@console/api")>("@console/api")); await loadCatalog("ko"); });
beforeEach(() => {
  state.search = {};
  state.error = undefined;
  state.readError = undefined;
  state.pending = false;
  state.hasData = true;
  state.candidates = [candidate("later", "전하윤", "2027-03-02"), candidate("first", "표진우", "2027-03-01")];
  vi.mocked(issueNotice).mockClear();
});

test("a notice opened from its list offers server candidates grouped by effective date", () => {
  const html = render();
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html).toContain("표진우");
  expect(html).toContain("전하윤");
  expect(html.indexOf("표진우")).toBeLessThan(html.indexOf("전하윤"));
  expect(html).toContain("채용팀");
  expect(html).not.toContain("일괄 발령의 받은 기록");
});

test("a free notice names the page consistently and waits for an event before offering issue", () => {
  const html = render();
  expect(html).toMatch(/<h1[^>]*>발령 공고<\/h1>/);
  expect(html).toContain("공고 제목");
  expect(html).not.toMatch(/<button[^>]*>공고 작성/);
  expect(html).not.toContain("발령 번호 받고 공고 작성");
});

test("the server's empty candidate page is an empty state", () => {
  state.candidates = [];
  const html = render();
  expect(html).toContain("공고에 넣을 발령이 없습니다");
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain("일괄 발령의 받은 기록");
});

test("URL event and batch receipts keep their existing issue payloads", async () => {
  state.search = { events: "first,later" };
  expect(render()).toMatch(/<h1[^>]*>발령 공고<\/h1>/);
  await state.command!.run(undefined, "event-key");
  expect(issueNotice).toHaveBeenLastCalledWith(expect.objectContaining({ event_ids: ["first", "later"], batch_id: undefined }), "event-key");
  state.search = { batch: "batch-1", count: 2 };
  render();
  await state.command!.run(undefined, "batch-key");
  expect(issueNotice).toHaveBeenLastCalledWith(expect.objectContaining({ batch_id: "batch-1", event_ids: undefined }), "batch-key");
});

test("a stale candidate shows the existing server eligibility refusal", () => {
  state.error = new ApiError(409, "appointment_notice_event_ineligible", "stale", []);
  expect(render()).toContain("취소되거나 철회된 발령은 공고에 포함하지 않습니다");
});

test("loading and denied candidate reads never claim there are no eligible events", () => {
  state.hasData = false;
  state.pending = true;
  expect(render()).toContain('role="status"');
  expect(render()).not.toContain("공고에 넣을 발령이 없습니다");
  state.pending = false;
  state.readError = new ApiError(403, "forbidden", "denied", []);
  const html = render();
  expect(html).toContain(t("common.denied.title.plain"));
  expect(html).toContain(t("common.denied.granters.unavailable"));
  expect(html).not.toContain(t("common.read.failedReason"));
  expect(html).not.toContain("denied");
  expect(html).not.toContain("공고에 넣을 발령이 없습니다");
  expect(html).not.toContain('type="checkbox"');
});

test("a failed background read keeps candidates visible alongside its retry", () => {
  state.readError = new ApiError(0, "network_error", "offline", []);
  const html = render();
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html).toContain('role="status"');
  expect(html).toContain(t("common.read.stale"));
  expect(html).toContain("다시 불러오기");
  expect(html).not.toContain("처리 여부 확인 중");
  expect(html).not.toContain("원래 요청의 결과");
});

test.each([403, 404])("a %s candidate read removes cached candidates, form and preview", status => {
  state.readError = new ApiError(status, status === 403 ? "forbidden" : "not_found", "raw upstream detail", []);
  const html = render();
  expect(html).toContain(t(status === 403 ? "common.denied.title.plain" : "common.read.notFound.title"));
  expect(html).not.toContain("표진우");
  expect(html).not.toContain("공고 제목");
  expect(html).not.toContain('<caption class="sr-only">공고 미리보기</caption>');
});


test("empty candidates hide the unsendable form and offer the people workspace", () => {
  state.candidates = [];
  const html = render();
  expect(html).not.toContain("공고 제목");
  expect(html).toContain('data-to="/people"');
});

test("preview has a reserved region after the form before any event is selected", () => {
  const html = render();
  const preview = html.indexOf('<caption class="sr-only">공고 미리보기</caption>');
  expect(preview).toBeGreaterThan(html.indexOf('id="notice-new"'));
});


test("a stale last candidate keeps its refusal visible after the candidate read becomes empty", () => {
  state.candidates = [];
  state.error = new ApiError(409, "appointment_notice_event_ineligible", "stale", []);
  const html = render();
  expect(html).toContain("취소되거나 철회된 발령은 공고에 포함하지 않습니다");
  expect(html).not.toContain("공고 제목");
});
