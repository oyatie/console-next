// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
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
beforeEach(() => { state.load = "ready"; state.missingDay = false; delete day.entry; delete day.intervals; day.marks = []; });
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

test("a day without interval judgments omits the minute breakdown entirely", () => {
  expect(render()).not.toContain(t("attendanceOverview.day.minutes"));
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

test("the source sentence leaves unapproved excess to its own row", () => {
  day.entry = { id: "entry", batch_id: "batch", kind: "TIMES", segments: [{ start: 540, end: 1260 }], source: "MANUAL", evidence_kind: "PAPER_SHEET", undone: false, created_at: "2026-10-06T12:00:00Z", created_by_name: "담당자" };
  day.recognition = { ...day.recognition, recognised: 600, regular: 480, outside_scheduled: 120, excess_open: 120 };
  const html = render();
  expect(html).toContain("수기 기록으로 10:00 인정 · 소정근로 내 8:00");
  expect(html.match(/미승인 초과 2:00/g)).toHaveLength(1);
});

for (const [locale, labels] of [
  ["ko", ["소정 근무", "근무 일정의 휴게", "사전 승인된 연장근로", "사후 승인된 연장근로", "사전 승인 없는 근로", "휴일 근로", "근로 아님으로 확인", "근무 일정 없음"]],
  ["en", ["Scheduled work", "Scheduled break", "Overtime approved in advance", "Overtime approved afterwards", "Work without prior approval", "Holiday work", "Confirmed non-work", "No work schedule"]],
] as const) test(`interval reason codes have readable ${locale} labels`, async () => {
  await loadCatalog(locale);
  i18n.set(locale);
  const codes = ["SCHEDULED_WORK", "SCHEDULED_BREAK", "PRIOR_APPROVED_OVERTIME", "POST_APPROVED_OVERTIME", "OPEN_OVERTIME", "HOLIDAY_WORK", "CONFIRMED_NOT_WORK", "SCHEDULE_MISSING"] as const;
  day.intervals = codes.map((reason_code, i) => ({ start: i * 60, end: (i + 1) * 60, minutes: 60, category: "WORK", recognised: true, reason_code, rule_version: "ATTENDANCE_RECOGNITION_V1" }));
  try {
    const html = render();
    for (const label of labels) expect(html).toContain(label);
    for (const code of codes) expect(html).not.toContain(code);
  } finally {
    i18n.set("ko");
  }
});
