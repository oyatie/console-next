// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Drafts } from "../domain/grid";
import { MonthTab } from "./month-tab";

const state = vi.hoisted(() => ({
  cursor: 0, people: 1, drafts: {} as Drafts, receipt: false, saveDock: false,
  load: "ready" as "ready" | "loading" | "error",
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const at = state.cursor++;
    if (at === 1 && state.saveDock) return [{ kind: "save" }, vi.fn()];
    if (at === 3 && state.receipt) return [{ saved: 1, opens: { blocking: 0, decision: 0 } }, vi.fn()];
    return actual.useState(initial);
  } };
});
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({ month: "2026-10" }), useNavigate: () => vi.fn() }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-href={to}>{children}</span>,
}));
vi.mock("@tanstack/react-query", async original => ({ ...await original<typeof import("@tanstack/react-query")>(), useInfiniteQuery: () => ({
  isPending: state.load === "loading", isSuccess: state.load === "ready", isError: state.load === "error",
  error: state.load === "error" ? new Error("unavailable") : null,
  data: state.load === "ready" ? { pages: [{ people_total: state.people, rows: state.people ? [
    { employee_id: "person", name: "Person", own: false, month_state: { state: "OPEN" }, cells: [] },
  ] : [] }] } : undefined,
}) }));
vi.mock("./use-drafts", () => ({ useDrafts: () => ({ drafts: state.drafts }) }));
vi.mock("./scope-picker", () => ({ ScopePicker: () => null }));
vi.mock("./month-grid-view", () => ({ MonthGridView: () => null }));
vi.mock("./save-dock", () => ({ SaveDock: () => <span data-testid="save-dock" /> }));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.cursor = 0;
  state.people = 1;
  state.drafts = {};
  state.receipt = false;
  state.saveDock = false;
  state.load = "ready";
});
const render = () => renderToStaticMarkup(<MonthTab />);

test("the month toolbar offers no future approval screen", () => {
  const html = render();
  expect(html).not.toContain("승인 기록");
  expect(html).not.toContain("연장·휴일근무는 승인 기록으로만 인정됩니다 · 승인 기록 화면이 열리면 이 근무표에서 바로 기록할 수 있습니다");
});

test("the save receipt keeps undo without offering a future review queue", () => {
  state.receipt = true;
  const html = render();
  expect(html).toContain(t("attendanceRecords.receipt.undo"));
  expect(html).not.toContain("확인 필요 보기");
  expect(html).not.toContain("확인 필요 화면이 열리면 이 저장에서 생긴 항목으로 바로 갑니다 · 지금은 근무표의 ▲ ◆ 표시로 찾습니다");
});

test("populated boards keep navigation without zero-draft save controls", () => {
  const html = render();
  expect(html).toContain('role="toolbar"');
  expect(html).toContain(t("attendanceRecords.toolbar.prevMonth"));
  expect(html).not.toContain(t("attendanceRecords.toolbar.unsaved", { count: 0, refused: 0 }));
  expect(html).not.toContain(t("attendanceRecords.save.nothing"));
  expect(html).not.toContain(`>${t("attendanceRecords.toolbar.save")} `);
});

test("the first draft exposes save status and command", () => {
  state.drafts = { "person|2026-10-06": { value: "=", base: null } };
  const html = render();
  expect(html).toContain(t("attendanceRecords.toolbar.unsaved", { count: 1, refused: 0 }));
  expect(html).toContain(`>${t("attendanceRecords.toolbar.save")} `);
});

test("a successful empty month hides its toolbar and keeps schedule assignment", () => {
  state.people = 0;
  const html = render();
  expect(html).not.toContain('role="toolbar"');
  expect(html).toContain(t("attendanceRecords.empty.toSchedule"));
});

test.each(["loading", "error"] as const)("%s preserves the existing toolbar behavior", (load) => {
  state.load = load;
  expect(render()).toContain('role="toolbar"');
});

test("opening save without drafts does not mount the save dock", () => {
  state.saveDock = true;
  expect(render()).not.toContain('data-testid="save-dock"');
});

test("opening save with a draft mounts the save dock", () => {
  state.saveDock = true;
  state.drafts = { "person|2026-10-06": { value: "=", base: null } };
  expect(render()).toContain('data-testid="save-dock"');
});
