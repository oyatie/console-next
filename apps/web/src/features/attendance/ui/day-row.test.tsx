// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { BoardRow } from "../api";
import { DayRow } from "./day-row";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
beforeAll(() => loadCatalog("ko"));
test("board status words and the time entry format stay visible", () => {
  const row: BoardRow = { employee_id: "person", name: "Person", own: false, month_state: { state: "OPEN" },
    day: { date: "2026-10-04", plan: { kind: "WORK", holiday_work: false }, marks: ["NO_RECORD"],
      recognition: { recorded: 0, recognised: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, late_in: 0, early_out: 0, away: 0, approval_unused: 0 } } };
  const html = renderToStaticMarkup(<DayRow row={row} onDraft={() => {}} onOpen={() => {}} onAssign={() => {}} />);
  expect(html).toContain(`<strong>${t("attendanceRecords.mark.NO_RECORD")}`);
  expect(html).toContain(t("attendanceRecords.grammar.hint"));
  expect(html).toContain('maxLength="40"');
});
