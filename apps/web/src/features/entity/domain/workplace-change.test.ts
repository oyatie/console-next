import { expect, test } from "vitest";
import type { KrAddress, WorkplaceInput } from "@console/api/pending";
import { moveChange, statusChange, statusProblems } from "./workplace-change";

const base = { name: "평택공장", same_address_as_registration: true, address: null, opened_on: "2020-03-02", status: "CONTINUING", status_since: null } as unknown as WorkplaceInput;
const addr = { source: "MANUAL_UNVERIFIED", road_addr_part1: "경기도 평택시 포승읍 평택항로 2" } as KrAddress;

test("regression: company-06 a 휴업 is dated with its expected end, a 재개 clears it", () => {
  const d = { since: "2026-10-01", until: "2027-01-31", reason: "SEASONAL" as const };
  expect(statusChange(base, d, true)).toMatchObject({ status: "SUSPENDED", status_since: "2026-10-01", status_until: "2027-01-31", effective_from: "2026-10-01", reason_code: "SUSPENSION_SEASONAL" });
  expect(statusChange(base, { ...d, until: "" }, true).status_until).toBeNull();
  expect(statusChange(base, { since: "2027-02-01", until: "", reason: null }, false)).toMatchObject({ status: "CONTINUING", status_since: null, status_until: null, reason_code: "RESUMPTION" });
});

test("negative: a 휴업 needs its start and reason; an end never precedes the start; a 재개 never precedes the 휴업", () => {
  expect(statusProblems({ since: "", until: "", reason: null }, true, { today: "2026-10-07" })).toEqual({ since: "required", reason: "required" });
  expect(statusProblems({ since: "2026-10-01", until: "2026-09-30", reason: "OTHER" }, true, { today: "2026-10-07" })).toEqual({ until: "untilBeforeSince" });
  expect(statusProblems({ since: "2026-11-01", until: "", reason: "OTHER" }, true, { today: "2026-10-07" })).toEqual({ since: "future" });
  expect(statusProblems({ since: "2026-10-01", until: "", reason: null }, false, { today: "2026-10-07", from: "2026-10-05" })).toEqual({ since: "beforeCurrent" });
  expect(statusProblems({ since: "2026-10-06", until: "", reason: null }, false, { today: "2026-10-07", from: "2026-10-05" })).toEqual({});
});

test("regression: company-07 이전 is a dated change of the workplace's own address; a 정정 applies from when the current one began", () => {
  expect(moveChange(base, addr, "MOVE", "2026-12-01", "2020-03-02")).toMatchObject({ same_address_as_registration: false, address: addr, effective_from: "2026-12-01", reason_code: "RELOCATION" });
  expect(moveChange(base, addr, "CORRECTION", "2026-12-01", "2020-03-02")).toMatchObject({ effective_from: "2020-03-02", reason_code: "CORRECTION" });
});
