// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fillSchedule } from "../domain/grid";
import { DayTab } from "./day-tab";

const state = vi.hoisted(() => ({ marks: ["NO_SCHEDULE"] }));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({ date: "2026-10-06" }), useNavigate: () => vi.fn() }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({
  isPending: false, error: null,
  data: {
    judged: true, marks: { blocking: 1, decision: 0 },
    ledger: { people: 1, no_schedule: 1, rest: 0, no_record: 0, missing_out: 0, absent: 0, outside: 0, trip: 0, late_or_early: 0, normal: 0, pending: 0 },
    groups: [{ workplace_id: "site", unit_id: "team", name: "Team", people: 1, normal: 0, no_schedule: 1, hidden: 0, marks: { blocking: 1, decision: 0 },
      rows: [{ employee_id: "person", name: "Person", month_state: { state: "OPEN" }, day: { marks: state.marks, plan: { kind: "NO_SCHEDULE" } } }],
    }],
  },
}) }));
vi.mock("./use-drafts", () => ({ useDrafts: () => ({ drafts: {} }) }));
vi.mock("./scope-picker", () => ({ ScopePicker: () => null }));
vi.mock("./day-row", () => ({ DayRow: () => null }));

beforeAll(() => loadCatalog("ko"));

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
