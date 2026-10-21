import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { activeTitles, currentTitle, isDemotion, suggestTitle, type JobTitle } from "./titles";

type LifecycleEvent = components["schemas"]["EmployeeLifecycleEvent"];
const lead = { id: "t1", kind: "GRADE" as const, label: "Lead", grade_rank: 30, active: true };
const staff = { id: "t2", kind: "GRADE" as const, label: "Staff", grade_rank: 10, active: true };
const old = { id: "t3", kind: "GRADE" as const, label: "Old", grade_rank: null, active: false };
const promote = (id: string, to: string | undefined, at: string, x: Partial<LifecycleEvent> = {}) =>
  ({ id, event_type: "PROMOTE", state: "APPLIED", to_job_title_id: to, created_at: at, ...x }) as LifecycleEvent;

test("only active titles are offered, in the server's order", () => {
  expect(activeTitles([lead, staff, old], "GRADE").map((x) => x.id)).toEqual(["t1", "t2"]);
});

test("the current title is the latest promotion in force; free text or a voided promotion does not count", () => {
  const all = [lead, staff];
  expect(currentTitle([promote("a", "t2", "2026-01-01"), promote("b", "t1", "2026-02-01")], all)?.id).toBe("t1");
  expect(currentTitle([promote("a", "t2", "2026-01-01"), promote("b", "t1", "2026-02-01", { voided_by: "r" })], all)?.id).toBe("t2");
  expect(currentTitle([promote("a", "t2", "2026-01-01"), promote("b", undefined, "2026-02-01")], all)).toBeUndefined();
});

test("a demotion is a move to a lower rank between two ranked titles", () => {
  expect(isDemotion(lead, staff)).toBe(true);
  expect(isDemotion(staff, lead)).toBe(false);
  expect(isDemotion(lead, { ...staff, grade_rank: null })).toBe(false);
  expect(isDemotion(undefined, staff)).toBe(false);
});

const t = (label: string, rank: number | null, kind: JobTitle["kind"] = "TITLE", active = true): JobTitle => ({ id: label, kind, label, grade_rank: rank, active });

test("the next ranked title above the one held, in the same list; none off the list or at the top", () => {
  const list = [t("사원", 1), t("주임", 2), t("대리", 3), t("과장", 5), t("차장", 4, "TITLE", false), t("부장", 6), t("반장", 9, "POSITION")];
  expect(suggestTitle("사원", list)?.label).toBe("주임");
  expect(suggestTitle("대리", list)?.label).toBe("과장");
  expect(suggestTitle("부장", list)).toBeUndefined();
  expect(suggestTitle("인턴", list)).toBeUndefined();
  expect(suggestTitle(null, list)).toBeUndefined();
});

test("each picker offers only its active catalog kind", () => {
  const items = [t("G1", 1, "GRADE"), t("Staff", 1), t("Lead", null, "POSITION"), t("Old", 2, "GRADE", false)];
  expect(activeTitles(items, "GRADE").map((x) => x.label)).toEqual(["G1"]);
  expect(activeTitles(items, "TITLE").map((x) => x.label)).toEqual(["Staff"]);
  expect(activeTitles(items, "POSITION").map((x) => x.label)).toEqual(["Lead"]);
});
