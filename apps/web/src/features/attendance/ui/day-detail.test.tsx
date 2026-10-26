// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { BoardRow, DayBoard } from "../api";
import type { useDrafts } from "./use-drafts";
import { DayDetail } from "./day-detail";

beforeAll(() => loadCatalog("ko"));
test("detail keeps every person and renders one native row group per board group", () => {
  const row = (id: string): BoardRow => ({
    employee_id: id, name: id, employee_number: id, own: false, month_state: { state: "OPEN" },
    day: { date: "2026-10-06", plan: { kind: "NO_SCHEDULE", holiday_work: false }, marks: ["NO_SCHEDULE"],
      recognition: { recorded: 0, recognised: 0, late_in: 0, early_out: 0, away: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, approval_unused: 0 } },
  });
  const groups = ["판교지점 › 영업1팀", "판교지점 › 지원팀"].map((name, i) => ({
    name, unit_id: name, people: i + 2, normal: 0, no_schedule: i + 2, hidden: 0,
    marks: { blocking: i + 2, decision: 0, info: 0 }, rows: Array.from({ length: i + 2 }, (_, n) => row(`${i}-${n}`)),
  }));
  const board = { date: "2026-10-06", ledger: { people: 5 }, groups } as DayBoard;
  const store = { drafts: {}, put: vi.fn(), set: vi.fn() } as unknown as ReturnType<typeof useDrafts>;
  const html = renderToStaticMarkup(<DayDetail board={board} store={store} onAssign={vi.fn()} />);
  expect(html.match(/data-id=/g)).toHaveLength(board.ledger.people);
  expect(html.match(/<tbody/g)).toHaveLength(groups.length);
  expect(html.match(/scope="rowgroup"/g)).toHaveLength(groups.length);
  for (const group of groups) {
    expect(html).toContain(group.name.replaceAll(">", "&gt;"));
    expect(html).toContain(t("attendanceRecords.board.groupMeta", { people: group.people, normal: group.normal, unscheduled: group.no_schedule, ...group.marks }));
  }
  expect(html.match(/>일정 지정</g)).toHaveLength(board.ledger.people);
  for (const rowHtml of html.match(/<tr[^>]*data-id=.*?<\/tr>/g) ?? []) {
    expect(rowHtml.split(t("attendance.dayKind.NO_SCHEDULE"))).toHaveLength(2);
  }
});
