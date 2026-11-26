// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { GridRow } from "../api";
import { MonthGridView } from "./month-grid-view";
import type { useDrafts } from "./use-drafts";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
beforeAll(() => loadCatalog("ko"));

test("zero-hour totals render as dashes", () => {
  const row: GridRow = {
    employee_id: "00000000-0000-0000-0000-000000000001", name: "Person", own: false, month_state: { state: "OPEN" },
    cells: [{ date: "2026-10-01", plan_kind: "WORK", recognised: 0, unrecognised: 0, not_worked: 0 }],
    totals: { recognised: 0, approved: 0, unrecognised: 0, not_worked: 0, blocking: 0, decision: 0 },
  };
  const store = { scope: "2026-10", drafts: {}, set: vi.fn(), put: vi.fn(), keep: vi.fn(), undo: vi.fn(), redo: vi.fn() } as unknown as ReturnType<typeof useDrafts>;
  const html = renderToStaticMarkup(<MonthGridView rows={[row]} total={1} days={["2026-10-01"]} store={store} range={null} onRange={() => {}} act={() => {}} />);
  expect(html).not.toContain(">0:00<");
  expect(html.match(/<td[^>]*>–<\/td>/g)).toHaveLength(4);
  const nonzero = renderToStaticMarkup(<MonthGridView rows={[{ ...row, totals: { ...row.totals, recognised: 480 } }]} total={1} days={["2026-10-01"]} store={store} range={null} onRange={() => {}} act={() => {}} />);
  expect(nonzero).toContain(">8:00<");
  expect(nonzero.match(/<td[^>]*>–<\/td>/g)).toHaveLength(3);
});

test("consoleOrder renders name before employee number and includes unit_name as 3rd lead column", () => {
  const row: GridRow = {
    employee_id: "00000000-0000-0000-0000-000000000001", employee_number: "10587", name: "Alice", unit_name: "Team-A", own: false, month_state: { state: "OPEN" },
    cells: [{ date: "2026-10-01", plan_kind: "WORK", recognised: 0, unrecognised: 0, not_worked: 0 }],
    totals: { recognised: 0, approved: 0, unrecognised: 0, not_worked: 0, blocking: 0, decision: 0 },
  };
  const store = { scope: "2026-10", drafts: {}, set: vi.fn(), put: vi.fn(), keep: vi.fn(), undo: vi.fn(), redo: vi.fn() } as unknown as ReturnType<typeof useDrafts>;
  const html = renderToStaticMarkup(<MonthGridView rows={[row]} total={1} days={["2026-10-01"]} store={store} range={null} onRange={() => {}} act={() => {}} consoleOrder />);
  expect(html).toContain(t("attendance.monthConsole.grid.unit"));
  expect(html.indexOf(">Alice<")).toBeLessThan(html.indexOf(">10587<"));
  expect(html.indexOf(">10587<")).toBeLessThan(html.indexOf(">Team-A<"));
  expect(html).not.toContain(">0:00<");
});

test("consoleOrder renders compact cell badges, active row marker, tail group header, and footer rows", () => {
  const row: GridRow = {
    employee_id: "00000000-0000-0000-0000-000000000001",
    employee_number: "10587",
    name: "Alice",
    unit_name: "Team-A",
    own: false,
    month_state: { state: "OPEN" },
    cells: [
      { date: "2026-10-01", plan_kind: "WORK", entry_kind: "TIMES", recognised: 480, unrecognised: 0, not_worked: 0, marks: [] },
      { date: "2026-10-02", plan_kind: "WORK", entry_kind: "TIMES", recognised: 600, unrecognised: 0, not_worked: 0, marks: [] },
      { date: "2026-10-03", plan_kind: "WORK", entry_kind: "TIMES", recognised: 660, unrecognised: 180, not_worked: 0, marks: ["UNAPPROVED_EXCESS"] },
      { date: "2026-10-04", plan_kind: "WORK", entry_kind: "TIMES", recognised: 460, unrecognised: 0, not_worked: 20, marks: ["LATE"] },
      { date: "2026-10-05", plan_kind: "WORK", recognised: 0, unrecognised: 0, not_worked: 0, marks: ["NO_RECORD"] },
      { date: "2026-10-06", plan_kind: "WORK", recognised: 0, unrecognised: 0, not_worked: 0, marks: [] },
      { date: "2026-10-07", plan_kind: "WORK", entry_kind: "TIMES", recognised: 240, unrecognised: 0, not_worked: 0, marks: [] },
      { date: "2026-10-08", plan_kind: "PUBLIC_HOLIDAY", entry_kind: "TIMES", recognised: 480, unrecognised: 0, not_worked: 0, marks: [] },
    ],
    totals: { recognised: 2920, approved: 600, unrecognised: 180, not_worked: 20, blocking: 1, decision: 1 },
  };
  const store = { scope: "2026-10", drafts: {}, set: vi.fn(), put: vi.fn(), keep: vi.fn(), undo: vi.fn(), redo: vi.fn() } as unknown as ReturnType<typeof useDrafts>;
  const html = renderToStaticMarkup(
    <MonthGridView
      rows={[row]}
      total={1}
      days={["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]}
      store={store}
      range={null}
      onRange={() => {}}
      act={() => {}}
      consoleOrder
      activeRowId={row.employee_id}
      tailGroupHeader={t("attendance.monthConsole.grid.tailGroup")}
      footerRows={[{ key: "worked", label: t("attendance.monthConsole.grid.footer.workedHeadcount"), day: () => 1, tail: ["48:40", "–", "–", "1"] }]}
    />,
  );
  expect(html).toContain('data-active="true"');
  expect(html).toContain(t("attendance.monthConsole.grid.tailGroup"));
  expect(html).toContain(t("attendance.monthConsole.grid.footer.workedHeadcount"));
  expect(html).toContain(">·<");
  expect(html).toContain(">+2<");
  expect(html).toContain(">+3<");
  expect(html).toContain(`>${t("attendance.monthConsole.grid.badge.late")}<`);
  // The month grid carries no leave, so an empty work day and a four-hour day stay unmarked rather than guessed as leave.
  expect(html).not.toContain('data-badge="annual"');
  expect(html).not.toContain('data-badge="half"');
  expect(html).toContain(`>${t("attendance.monthConsole.grid.badge.holidayWork")}<`);
  expect(html).not.toContain(">0:00<");
});

test("consoleOrder prefers position over unit_name as 3rd lead column when present", () => {
  const row: GridRow = {
    employee_id: "00000000-0000-0000-0000-000000000001",
    employee_number: "10587",
    name: "Alice",
    unit_name: "Team-A",
    position: "Senior Staff · Crew Lead",
    own: false,
    month_state: { state: "OPEN" },
    cells: [{ date: "2026-10-01", plan_kind: "WORK", recognised: 0, unrecognised: 0, not_worked: 0 }],
    totals: { recognised: 0, approved: 0, unrecognised: 0, not_worked: 0, blocking: 0, decision: 0 },
  };
  const store = { scope: "2026-10", drafts: {}, set: vi.fn(), put: vi.fn(), keep: vi.fn(), undo: vi.fn(), redo: vi.fn() } as unknown as ReturnType<typeof useDrafts>;
  const html = renderToStaticMarkup(<MonthGridView rows={[row]} total={1} days={["2026-10-01"]} store={store} range={null} onRange={() => {}} act={() => {}} consoleOrder />);
  expect(html).toContain(t("attendance.monthConsole.grid.position"));
  expect(html).toContain(">Senior Staff · Crew Lead<");
  expect(html).not.toContain(t("attendance.monthConsole.grid.unit"));
});
