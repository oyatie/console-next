// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Day } from "../api";
import { DayDock } from "./day-dock";

const state = vi.hoisted(() => ({ load: "ready" as "ready" | "loading" | "error", missingDay: false }));
const day: Day = {
  date: "2026-10-06", plan: { kind: "REST_DAY", holiday_work: false }, marks: [],
  recognition: { recorded: 0, recognised: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, late_in: 0, early_out: 0, away: 0, approval_unused: 0 },
};
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({
  isPending: state.load === "loading", error: state.load === "error" ? new Error("unavailable") : null,
  data: state.load === "ready" ? { name: "Person", days: state.missingDay ? [] : [day], history: [], month_state: { state: "OPEN" } } : undefined,
}) }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.load = "ready"; state.missingDay = false; });
const render = () => renderToStaticMarkup(<DayDock employeeId="person" date={day.date} own={false} onClose={() => {}} onRewrite={() => {}} onDone={() => {}} />);

test("the person-day dock offers exactly the three served tabs", () => {
  const html = render();
  expect(html.match(/role="tab"/g)).toHaveLength(3);
  for (const tab of ["day", "source", "history"] as const) expect(html).toContain(t(`attendanceRecords.day.tab.${tab}`));
  expect(html).not.toContain(`>${t("attendanceRecords.day.tab.week")}<`);
  expect(html).not.toContain("주 52시간 판정 · 승인 내역: 연동 예정");
  expect(html).toContain(t("attendanceRecords.day.rewrite"));
});

test("a missing day never falls back to future-screen copy", () => {
  state.missingDay = true;
  expect(render()).not.toContain("주 52시간 판정 · 승인 내역: 연동 예정");
});

test("loading keeps the loading state without tabs", () => {
  state.load = "loading";
  const html = render();
  expect(html).toContain(t("common.loading"));
  expect(html).not.toContain('role="tab"');
});

test("a failed read keeps its retry state without tabs", () => {
  state.load = "error";
  const html = render();
  expect(html).toContain(t("common.loadFailed.title"));
  expect(html).toContain(t("common.retry"));
  expect(html).not.toContain('role="tab"');
});


test("paid excess is shown separately from regular time without using approval as the pay test", () => {
  day.recognition = { ...day.recognition, recognised: 600, regular: 480,
    outside_scheduled: 120, excess_open: 120, prior_approved: 0, post_approved: 0,
    not_work: 0, over_cap: false, late_unrecognised: 999 };
  day.marks = ["UNAPPROVED_EXCESS"];
  const html = render();
  expect(html).toContain("10:00 · 소정 안 8:00");
  expect(html).toContain("2:00 · 미승인 초과 2:00");
  expect(html).toContain("승인이 없어도 근로시간으로 인정 · 마감 전에 처리");
  expect(html).not.toContain("인정하지 않은 체류");
});
