// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { Day } from "../api";
import { DayBar, DayBars } from "./day-bar";

beforeAll(() => loadCatalog("ko"));
const day = (start: number, end: number) => ({ date: "2026-10-04", plan: { kind: "WORK", holiday_work: false, shift: { start, end, breaks: [] } }, marks: [], recognition: { recorded: 0, recognised: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, late_in: 0, early_out: 0, away: 0, approval_unused: 0 } }) as Day;
test("a board uses one axis including night work, one legend and a table of every span", () => {
  const days = [day(480, 1020), day(1320, 1800)];
  const html = renderToStaticMarkup(<DayBars days={days} labels={["주간직원", "야간직원"]}>{days.map((d, i) => <DayBar key={i} day={d} />)}</DayBars>);
  const boxes = [...html.matchAll(/viewBox="([^"]+ 20)"/g)].map(m => m[1]);
  expect(boxes).toHaveLength(2);
  expect(new Set(boxes).size).toBe(1);
  expect(html.match(/<table/g)).toHaveLength(1);
  expect(html).toContain("예정");
  expect(html).toContain("기록");
  expect(html).toContain("인정");
  expect(html).toContain("야간직원");
  expect(html).toContain("06:00 (+1)");
});
test("clock-in without a plan is included in the shared axis and the text table", () => {
  const d = { ...day(480, 1020), plan: { kind: "NO_SCHEDULE", holiday_work: false }, entry: { kind: "CLOCK_IN_ONLY", segments: [{ start: 1320, end: 1320 }] } } as Day;
  const html = renderToStaticMarkup(<DayBars days={[d]} labels={["직원"]}><DayBar day={d} /></DayBars>);
  expect(html).toContain("22:00");
  expect(html).toContain("퇴근 미기록");
  expect(html).not.toContain("NaN");
});
