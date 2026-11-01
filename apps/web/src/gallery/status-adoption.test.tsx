// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import * as enums from "../lib/labels";
import { MarkChip, MarkGlyph } from "../features/attendance/ui/mark-chip";
import { toneCounts } from "../features/attendance/present";
import { PlanList } from "../features/org-bulk/ui/plan-list";
import { EnforcementChip } from "../features/access/ui/holder";
import { RequestChip } from "../features/periods/ui/unlock-request";
import { CloseJobPanel } from "../features/entity/ui/close-job";
import { statusOf } from "../features/people/present";
import type { Mark } from "../features/attendance/api";
import type { PlanRow } from "../features/org-bulk/domain/plan";
import type { CloseJob, ClosePlanView } from "../reference/close/api";

vi.mock("../lib/labels", async original => {
  const actual = await original<typeof import("../lib/labels")>();
  return { ...actual, labeled: vi.fn(actual.labeled) };
});

beforeAll(() => loadCatalog("ko"));
beforeEach(() => { vi.mocked(enums.labeled).mockClear(); });

test.each([
  ["NO_RECORD", "danger", "▲"], ["MISSING_OUT", "danger", "▲"], ["NO_SCHEDULE", "danger", "▲"],
  ["UNAPPROVED_EXCESS", "warn", "◆"], ["WORK_ON_REST_DAY", "warn", "◆"],
  ["LATE", "info", "●"], ["EARLY_OUT", "info", "●"], ["AWAY", "info", "●"], ["ABSENT", "info", "●"],
] as const)("attendance %s keeps its glyph and reads its tone from the registry", (mark, tone, glyph) => {
  const chip = html(<MarkChip mark={mark} />);
  expect(enums.labeled).toHaveBeenCalledWith(enums.ATTENDANCE_MARK, mark);
  expect(chip).toContain(`chip--${tone}`);
  expect(chip).toContain(`${glyph}</span> ${enums.label(enums.ATTENDANCE_MARK, mark)}`);
  expect(html(<MarkGlyph mark={mark} />)).toContain(`<span>${enums.label(enums.ATTENDANCE_MARK, mark)}</span>`);
});

test("future attendance marks stay readable and do not enter known category totals", () => {
  const result = html(<MarkChip mark={"FUTURE_MARK" as Mark} />);
  expect(result).toContain('chip--neutral');
  expect(result).toContain('FUTURE_MARK');
  expect(toneCounts(["NO_RECORD", "UNAPPROVED_EXCESS", "LATE", "LATE", "FUTURE_MARK", "constructor"]))
    .toEqual({ blocking: 1, decision: 1, info: 2 });
});

test.each(["link", "create", "createSite", "clash", "tooDeep", "kind_not_allowed"] as const)("bulk plan %s uses the registry and keeps rename behavior", value => {
  const status = value === "createSite" ? "create" : value;
  const row = { at: 0, line: 1, name: "Synthetic unit", depth: 0, level: value === "createSite" ? "workplace" : "dept", status } as PlanRow;
  const result = html(<PlanList rows={[row]} names={{}} onRename={() => undefined} rootName="Synthetic entity" levelOffset={0} />);
  expect(enums.labeled).toHaveBeenCalledWith(enums.ORG_BULK_PLAN_STATUS, value);
  expect(result).toContain(`chip--${enums.ORG_BULK_PLAN_STATUS.tone?.[value]}`);
  expect(result).toContain(enums.label(enums.ORG_BULK_PLAN_STATUS, value));
  expect(result.includes("<input")).toBe(value === "clash");
});

test.each(["ENFORCED", "PREPARED", "SCHEDULED", "ENDED", "REVOKED", "ROLE_INACTIVE", "SCOPE_UNAVAILABLE", "ACCOUNT_INACTIVE", "FUTURE_STATE"])("grant state %s uses the registry", value => {
  const result = html(<EnforcementChip e={value} />);
  expect(enums.labeled).toHaveBeenCalledWith(enums.ACCESS_ENFORCEMENT, value);
  expect(result).toContain(enums.label(enums.ACCESS_ENFORCEMENT, value));
});

test.each(["PENDING", "REJECTED", "EXPIRED"] as const)("unlock %s keeps its state word", value => {
  const result = html(<RequestChip state={value} />);
  expect(enums.labeled).toHaveBeenCalledWith(enums.PERIOD_UNLOCK_STATE, value);
  expect(result).toContain(enums.label(enums.PERIOD_UNLOCK_STATE, value));
});

test.each(["APPROVED", "SUPERSEDED"] as const)("unlock %s stays absent from in-force rows", state => {
  expect(html(<RequestChip state={state} />)).toBe("");
});

test.each(["OPEN", "APPLIED", "DECLINED", "WITHDRAWN"] as const)("people request %s reads its shared word and tone", value => {
  const result = statusOf(value);
  expect(enums.labeled).toHaveBeenCalledWith(enums.CHANGE_REQUEST_STATUS, value);
  expect(result).toEqual(enums.labeled(enums.CHANGE_REQUEST_STATUS, value));
});

test.each(["SCHEDULED", "WAITING", "APPLIED", "FAILED", "CANCELLED"] as const)("close job %s keeps its date and receipt announcement", state => {
  const job = { state, closed_on: "2026-10-27", lines: [], failure: null } as unknown as CloseJob;
  const result = html(<CloseJobPanel job={job} view={{} as ClosePlanView} />);
  expect(result).toContain(`chip--${enums.WORKPLACE_CLOSE_STATE.tone?.[state]}`);
  expect(result.match(/role="status"/g)).toHaveLength(1);
  expect(result).not.toContain("{date}");
});
