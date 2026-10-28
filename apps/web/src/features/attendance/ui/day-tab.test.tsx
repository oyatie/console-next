// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import { fillSchedule, type Drafts } from "../domain/grid";
import { DayTab } from "./day-tab";

const stateQuery = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ marks: ["NO_SCHEDULE"], people: 1, judged: true, ledgerGap: false, drafts: {} as Drafts, detail: false, placeholder: false, hidden: 0, load: "ready" as "ready" | "loading" | "error" }));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({ date: "2026-10-06", detail: state.detail }), useNavigate: () => vi.fn() }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-href={to}>{children}</span>,
}));
vi.mock("@tanstack/react-query", async original => ({ ...await original<typeof import("@tanstack/react-query")>(), useQuery: (options: unknown) => { stateQuery(options); return ({
  isPlaceholderData: state.placeholder,
  isPending: state.load === "loading", isSuccess: state.load === "ready", error: state.load === "error" ? new Error("unavailable") : null,
  data: state.load === "ready" ? {
    date: "2026-10-06", judged: state.judged, marks: { blocking: 1, decision: 0 },
    ledger: { people: state.people, no_schedule: state.ledgerGap ? 0 : state.people, rest: 0, no_record: 0, missing_out: 0, absent: 0, outside: 0, trip: 0, late_or_early: 0, normal: 0, pending: 0 },
    groups: state.people ? [{ workplace_id: "site", unit_id: "team", name: "Team", people: state.people, normal: 0, no_schedule: state.people, hidden: state.hidden, marks: { blocking: 1, decision: 0 },
      rows: [{ employee_id: "person", name: "Person", month_state: { state: "OPEN" }, day: { recognition: { recognised: 0 }, marks: state.marks, plan: { kind: "NO_SCHEDULE" } } }],
    }] : [],
  } : undefined,
}); } }));
vi.mock("./use-drafts", () => ({ useDrafts: () => ({ drafts: state.drafts }) }));
vi.mock("./scope-picker", () => ({ ScopePicker: () => null }));
vi.mock("./day-row", () => ({ DayRow: () => null }));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.marks = ["NO_SCHEDULE"];
  state.people = 1;
  state.judged = true;
  state.ledgerGap = false;
  state.drafts = {};
  state.load = "ready";
  state.detail = false;
  state.placeholder = false;
  state.hidden = 0;
  stateQuery.mockClear();
});

test("a successful empty board hides its toolbar and names schedule assignment", () => {
  state.people = 0;
  const html = renderToStaticMarkup(<DayTab />);
  expect(html).not.toContain('role="toolbar"');
  expect(html).toContain(t("attendanceRecords.empty.toSchedule"));
  expect(html).toContain('data-href="/attendance"');
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

test("detail waits for the complete population instead of mounting folded placeholder rows", () => {
  state.detail = true;
  state.placeholder = true;
  state.people = 2;
  state.hidden = 1;
  const html = renderToStaticMarkup(<DayTab />);
  expect(html).not.toContain(t("attendanceRecords.detail.label"));
  expect(html).toContain('role="status"');
});

test("a complete detail population stays rendered during a filter read", () => {
  state.detail = true;
  state.placeholder = true;
  expect(renderToStaticMarkup(<DayTab />)).toContain(t("attendanceRecords.detail.label"));
});
