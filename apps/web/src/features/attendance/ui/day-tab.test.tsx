// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MouseEvent, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import type { Button } from "../../../ui/button/button";
import type { IssueGroup, Mark } from "../api";
import { fillSchedule, type Drafts } from "../domain/grid";
import { DayTab } from "./day-tab";

const stateQuery = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  marks: ["NO_SCHEDULE"] as Mark[], mark: undefined as Mark | undefined, issueGroups: [] as IssueGroup[], issues: false,
  people: 1, blocking: 1, judged: true, ledgerGap: false, drafts: {} as Drafts, detail: false, load: "ready" as "ready" | "loading" | "error",
  buttons: [] as Parameters<typeof Button>[0][], navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({ date: "2026-10-06", detail: state.detail, mark: state.mark, issues: state.issues }), useNavigate: () => state.navigate }),
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <span data-href={to} className={className}>{children}</span>,
}));
vi.mock("@tanstack/react-query", async original => ({ ...await original<typeof import("@tanstack/react-query")>(), useQuery: (options: unknown) => { stateQuery(options); return ({
  isPending: state.load === "loading", isSuccess: state.load === "ready", error: state.load === "error" ? new Error("unavailable") : null,
  data: state.load === "ready" ? {
    date: "2026-10-06", judged: state.judged, marks: { blocking: state.blocking, decision: 0 },
    issue_groups: state.issueGroups,
    ledger: { people: state.people, no_schedule: state.ledgerGap ? 0 : state.people, rest: 0, no_record: 0, missing_out: 0, absent: 0, outside: 0, trip: 0, late_or_early: 0, normal: 0, pending: 0 },
    groups: state.people ? [{ workplace_id: "site", unit_id: "team", name: "Team", people: state.people, normal: 0, no_schedule: state.people, hidden: 0, marks: { blocking: state.blocking, decision: 0 },
      rows: [{ employee_id: "person", name: "Person", month_state: { state: "OPEN" }, day: { recognition: { recognised: 0 }, marks: state.marks, plan: { kind: "NO_SCHEDULE" } } }],
    }] : [],
  } : undefined,
}); } }));
vi.mock("../../../ui/button/button", async original => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (props: Parameters<typeof Button>[0]) => { state.buttons.push(props); return <actual.Button {...props} />; } };
});
vi.mock("./use-drafts", () => ({ useDrafts: () => ({ drafts: state.drafts }) }));
vi.mock("./scope-picker", () => ({ ScopePicker: () => null }));
vi.mock("./day-row", () => ({ DayRow: () => null }));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.marks = ["NO_SCHEDULE"];
  state.people = 1;
  state.blocking = 1;
  state.judged = true;
  state.ledgerGap = false;
  state.drafts = {};
  state.load = "ready";
  state.detail = false;
  state.mark = undefined;
  state.issueGroups = [];
  state.issues = false;
  state.buttons = [];
  state.navigate.mockClear();
  stateQuery.mockClear();
});

test("a successful empty board hides its toolbar and names schedule assignment", () => {
  state.people = 0;
  const html = renderToStaticMarkup(<DayTab />);
  expect(html).not.toContain('role="toolbar"');
  expect(html).toContain(t("attendanceRecords.empty.toSchedule"));
  expect(html).toContain('data-href="/attendance"');
  expect(html).toContain('class="btn btn--primary"');
  expect(html).not.toContain(t("attendanceRecords.board.ledgerHead", { people: 0 }));
  expect(html).not.toContain(t("attendanceRecords.rail.title"));
});

test("a settled board omits zero-valued next steps", () => {
  state.blocking = 0;
  const html = renderToStaticMarkup(<DayTab />);
  expect(html).not.toContain(t("attendanceRecords.rail.process", { count: 0 }));
  expect(html).not.toContain(t("attendanceRecords.rail.groups"));
});

test("populated boards keep navigation and filters without save controls until a draft exists", () => {
  const html = renderToStaticMarkup(<DayTab />);
  expect(html).toContain('role="toolbar"');
  expect(html).toContain(t("attendanceRecords.toolbar.prevDay"));
  expect(html).toContain(t("attendanceRecords.board.issuesOnly"));
  expect(html).not.toContain(t("attendanceRecords.toolbar.unsaved", { count: 0, refused: 0 }));
  expect(html).not.toContain(t("attendanceRecords.save.nothing"));
  expect(html).not.toContain(`>${t("attendanceRecords.toolbar.save")}<`);
});

test("the first draft exposes the save status and save command", () => {
  state.drafts = { "person|2026-10-06": { value: "=", base: null } };
  const html = renderToStaticMarkup(<DayTab />);
  expect(html).toContain(t("attendanceRecords.toolbar.unsaved", { count: 1, refused: 0 }));
  expect(html).toContain(`>${t("attendanceRecords.toolbar.save")}<`);
});

test.each([[false, false], [false, true], [true, false], [true, true]])("day notices retain their separate tones (judged=%s, ledgerGap=%s)", (judged, ledgerGap) => {
  state.judged = judged;
  state.ledgerGap = ledgerGap;
  const html = renderToStaticMarkup(<DayTab />);
  const info = renderToStaticMarkup(<Banner tone="info">{t("attendanceRecords.board.notJudged")}</Banner>);
  const warning = renderToStaticMarkup(<Banner tone="warn">{t("attendanceRecords.board.ledgerGap")}</Banner>);
  expect(html.includes(info)).toBe(!judged);
  expect(html.includes(warning)).toBe(ledgerGap);
});

test.each(["loading", "error"] as const)("%s keeps its existing toolbar behavior", (load) => {
  state.load = load;
  expect(renderToStaticMarkup(<DayTab />)).toContain('role="toolbar"');
});

test("the rail offers schedule assignment instead of recording when every row lacks a schedule", () => {
  state.marks = ["NO_SCHEDULE"];
  const html = renderToStaticMarkup(<DayTab />);
  const rail = html.slice(html.indexOf('aria-label="기록이 비어 있는 곳"'));
  expect(html).not.toContain("소정대로 기록");
  expect(rail).toContain("일정 없음 1명 보기");
});

test("the rail offers recording for a group with a missing record", () => {
  state.marks = ["NO_RECORD"];
  expect(renderToStaticMarkup(<DayTab />)).toContain("소정대로 기록");
});

test("the fill receipt names unscheduled skips without claiming a locked row", () => {
  const r = fillSchedule([{ key: "person|2026-10-06", planKind: "NO_SCHEDULE", entryId: null, own: false, closed: false }], {});
  const note = t("attendanceRecords.fill.done", { filled: r.filled, ...r.skipped });
  expect(note).toContain("일정 없음 1");
  expect(note).toContain("본인·마감 0");
});

test("only the detailed board requests all rows, in a separate cache entry", () => {
  renderToStaticMarkup(<DayTab />);
  const compact = stateQuery.mock.calls[0]![0];
  state.detail = true;
  stateQuery.mockClear();
  state.people = 0;
  renderToStaticMarkup(<DayTab />);
  const detail = stateQuery.mock.calls[0]![0];
  expect(JSON.stringify(compact)).not.toContain('"rows":"all"');
  expect(JSON.stringify(detail)).toContain('"rows":"all"');
  expect(detail).not.toEqual(compact);
});

test("a pending detail read never retains rows from the previous filter", () => {
  state.detail = true;
  state.load = "loading";
  const html = renderToStaticMarkup(<DayTab />);
  expect(stateQuery.mock.calls[0]![0]).not.toHaveProperty("placeholderData");
  expect(html).not.toContain(t("attendanceRecords.detail.label"));
  expect(html).toContain('role="status"');
});

test("a selected review kind filters the board query", () => {
  state.mark = "MISSING_OUT";
  renderToStaticMarkup(<DayTab />);
  expect(JSON.stringify(stateQuery.mock.calls[0]![0])).toContain('"mark":"MISSING_OUT"');
});

test("review groups with only zero counts stay absent", () => {
  state.issueGroups = [{ kind: "NO_RECORD", count: 0, earliest_date: "2026-10-01" }];
  expect(renderToStaticMarkup(<DayTab />)).not.toContain(t("attendanceOverview.issues.groups"));
});

test("clearing a filtered empty state resets its review kind with every board filter", () => {
  state.people = 0;
  state.issues = true;
  state.mark = "MISSING_OUT";
  renderToStaticMarkup(<DayTab />);
  const clear = state.buttons.find(button => button.children === t("attendanceRecords.empty.clear"));
  expect(clear).toBeDefined();
  clear!.onClick!({} as MouseEvent<HTMLButtonElement>);
  const update = state.navigate.mock.calls[0]![0].search;
  expect(update({ issues: true, mark: "MISSING_OUT", unscheduled: true, wp: "site", unit: "team" })).toEqual({
    issues: undefined, mark: undefined, unscheduled: undefined, wp: undefined, unit: undefined,
  });
});
