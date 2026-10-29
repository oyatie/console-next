// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { BoardRow } from "../api";
import { DayRow } from "./day-row";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
beforeAll(() => loadCatalog("ko"));
const grammarHintId = "board-grammar";
test("board status words stay visible and inputs describe the shared format hint", () => {
  const row: BoardRow = { employee_id: "person", name: "Person", own: false, month_state: { state: "OPEN" },
    day: { date: "2026-10-04", plan: { kind: "WORK", holiday_work: false }, marks: ["NO_RECORD"],
      recognition: { recorded: 0, recognised: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, late_in: 0, early_out: 0, away: 0, approval_unused: 0 } } };
  const html = renderToStaticMarkup(<DayRow row={row} grammarHintId={grammarHintId} onDraft={() => {}} onOpen={() => {}} onAssign={() => {}} />);
  expect(html).toContain(`<strong>${t("attendanceRecords.mark.NO_RECORD")}`);
  expect(html).not.toContain(t("attendanceRecords.grammar.hint"));
  expect(html).toContain(`aria-describedby="${grammarHintId}"`);
  expect(html).toContain('maxLength="40"');
});

test.each(["LATE", "EARLY_OUT"] as const)("%s is named once in the status sentence", mark => {
  const row: BoardRow = { employee_id: "person", name: "Person", own: false, month_state: { state: "OPEN" },
    day: { date: "2026-10-04", plan: { kind: "WORK", holiday_work: false }, marks: [mark],
      recognition: { recorded: 0, recognised: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, late_in: 5, early_out: 0, away: 0, approval_unused: 0 } } };
  const text = renderToStaticMarkup(<DayRow row={row} grammarHintId={grammarHintId} onDraft={() => {}} onOpen={() => {}} onAssign={() => {}} />).replace(/<[^>]*>/g, "");
  expect(text.split(t(`attendanceRecords.mark.${mark}`))).toHaveLength(2);
  expect(text).toContain("5분");
});
