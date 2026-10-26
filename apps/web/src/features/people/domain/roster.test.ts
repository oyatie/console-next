import { describe, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { retentionEnd, exactNumber, facetQueries, headcount, joinReview, listQuery, nextItems, offeredVerbs, parseReview, parseStatus, reviewCounts, reviewTotals, statusCounts, statusTotals, tenure, toggleReview } from "./roster";

type Employee = components["schemas"]["Employee"];
const person = (p: Partial<Employee>): Employee => ({ id: "1", company: "c", name: "n", org_unit_id: null, legal_entity_id: null, workplace_id: null, home_branch_review_required: false, identity_resolution_strategy: "employee_number", identity_resolution_confidence: "high", identity_review_required: false, identity_name_only_merge: false, next_event: null, failed_event: null, created_at: "", updated_at: "", status: "ACTIVE", ...p });
const TODAY = "2026-10-02";

test("the roster next exit and its distance use the first non-employed day", () => {
  const e = person({ next_event: { id: "exit", event_type: "TERMINATE", effective_date: "2026-10-31" } as Employee["next_event"] });
  expect(nextItems(e, "2026-10-31", 60)).toEqual([{ kind: "event", event: "TERMINATE", date: "2026-11-01", days: 1 }]);
});

describe("filters in the URL", () => {
  test("status: nothing means the current staff; unknown values fall back to it", () => {
    expect(parseStatus(undefined)).toBe("current");
    expect(parseStatus("EXITED")).toBe("EXITED");
    expect(parseStatus("bogus")).toBe("current");
  });
  test("review chips combine; the two contract chips are one server filter, so one replaces the other", () => {
    expect(parseReview("failed,identity,nope")).toEqual(["identity", "failed"]);
    expect(parseReview("contractPast,contractSoon")).toEqual(["contractPast"]);
    expect(toggleReview(["contractPast", "identity"], "contractSoon")).toEqual(["identity", "contractSoon"]);
    expect(toggleReview(["identity"], "identity")).toEqual([]);
    expect(joinReview([])).toBeUndefined();
    expect(joinReview(["failed", "identity"])).toBe("identity,failed");
  });
});

describe("unplaced review", () => {
  test("uses its own URL key while retiring branch and preserving independent review chips", () => {
    expect(parseReview("branch,unplaced,identity")).toEqual(["identity", "unplaced"]);
    expect(joinReview(["unplaced", "identity"])).toBe("identity,unplaced");
    expect(toggleReview(["identity"], "unplaced")).toEqual(["identity", "unplaced"]);
    expect(toggleReview(["identity", "unplaced"], "unplaced")).toEqual(["identity"]);
  });
  test("filters the list and its facets through the server's kept placement-gap field", () => {
    const filter = { status: "current", review: ["unplaced", "identity"] } as const;
    expect(listQuery(filter, TODAY, 60)).toMatchObject({ home_branch_review_required: true, identity_review_required: true });
    const facets = facetQueries(filter, TODAY, 60);
    expect(facets.list).toMatchObject({ home_branch_review_required: true });
    expect(facets.review).not.toHaveProperty("home_branch_review_required");
    expect(listQuery({ status: "current", review: [] }, TODAY, 60).home_branch_review_required).toBeUndefined();
  });
  test("counts only the server's placement gaps, including zero and an unknown read", () => {
    for (const count of [0, 1, 2000]) {
      const review = { contract_ended: 0, contract_ending_before: 0, identity_review_required: 9, home_branch_review_required: count, register_review_required: 8, lifecycle_apply_failed: 7 };
      expect(reviewTotals(reviewCounts(review)).unplaced).toBe(count);
    }
    expect(reviewTotals(reviewCounts(undefined)).unplaced).toBeUndefined();
  });
});

describe("server queries", () => {
  test("the list asks exactly the chosen filters; the contract window matches Home's (strictly before)", () => {
    expect(listQuery({ status: "current", review: ["contractSoon"], unit: "u1", q: "kim" }, TODAY, 60)).toEqual({
      search: "kim",
      org_unit_id: "u1",
      status: ["ACTIVE", "ON_LEAVE", "UNKNOWN", "PRE_HIRE"],
      identity_review_required: undefined,
      lifecycle_apply_failed: undefined,
      contract_ending_before: "2026-12-02",
    });
    expect(listQuery({ status: "all", review: ["contractPast"] }, TODAY, 60)).toMatchObject({ status: undefined, contract_ending_before: TODAY });
  });
  test("two facet reads: the list's own filter, and the status filter with the renewal window for the review chips", () => {
    const c = facetQueries({ status: "EXITED", review: ["failed"], q: "k" }, TODAY, 60);
    expect(c.list).toMatchObject({ status: ["EXITED"], search: "k", lifecycle_apply_failed: true });
    expect(c.review).toEqual({ status: ["EXITED"], search: "k", org_unit_id: undefined, contract_ending_before: "2026-12-02" });
  });
  test("facet counts in chip order; an unlisted status is 0, a missing read unknown", () => {
    expect(statusCounts([{ value: "ON_LEAVE", count: 2 }, { value: "ACTIVE", count: 10 }, { value: "PRE_HIRE", count: 3 }])).toEqual([10, 2, 0, 0, 3]);
    expect(statusCounts(undefined)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const review = { contract_ended: 2, contract_ending_before: 17, identity_review_required: 3, home_branch_review_required: 21, register_review_required: 7, lifecycle_apply_failed: 1 };
    expect(reviewTotals(reviewCounts(review))).toEqual({ contractPast: 2, contractSoon: 15, identity: 3, unplaced: 21, register: 7, failed: 1 });
  });
});

describe("chip totals are server totals, added up", () => {
  test("status: current = active + on leave + unknown + starting soon; all adds exited; a missing total is unknown", () => {
    expect(statusTotals([10, 2, 1, 5, 3])).toMatchObject({ current: 16, all: 21, EXITED: 5, PRE_HIRE: 3 });
    expect(statusTotals([10, undefined, 1, 5, 0])).toMatchObject({ current: undefined, all: undefined, ACTIVE: 10 });
  });
  test("인원 matches the chart's employed population (입사 예정 apart)", () => {
    expect(headcount(statusTotals([10, 2, 1, 5, 3]))).toBe(13);
    expect(headcount(statusTotals([10, undefined, 1, 5, 3]))).toBeUndefined();
    expect(headcount(statusTotals([10, 2, undefined, 5, 3]))).toBeUndefined();
  });
  test("contracts ending within the window exclude those already over", () => {
    expect(reviewTotals([2, 17, 3, 21, 7, 1])).toEqual({ contractPast: 2, contractSoon: 15, identity: 3, unplaced: 21, register: 7, failed: 1 });
  });
});

describe("next item", () => {
  test("a failed action comes first, then the scheduled one, then a contract ending soon", () => {
    const e = person({
      failed_event: { id: "f", event_type: "TRANSFER", effective_date: "2026-10-01", failure_code: "lifecycle_noop" },
      next_event: { id: "n", event_type: "PROMOTE", effective_date: "2026-11-01" } as Employee["next_event"],
      contract_end_date: "2026-11-16",
    });
    expect(nextItems(e, TODAY, 60).map((i) => i.kind)).toEqual(["failed", "event", "contract"]);
    expect(nextItems(e, TODAY, 60)[1]).toMatchObject({ days: 30 });
  });
  test("a contract shows only inside the window or once over, and never for someone who left", () => {
    expect(nextItems(person({ contract_end_date: "2027-01-31" }), TODAY, 60)).toEqual([]);
    expect(nextItems(person({ contract_end_date: "2026-09-30" }), TODAY, 60)).toEqual([{ kind: "contract", date: "2026-09-30", days: -2 }]);
    expect(nextItems(person({ contract_end_date: "2026-09-30", status: "EXITED" }), TODAY, 60)).toEqual([]);
  });
  test("someone on leave shows the expected return the leave named, unless the return is already scheduled", () => {
    expect(nextItems(person({ status: "ON_LEAVE", expected_return_date: "2027-04-21" }), TODAY, 60)).toEqual([{ kind: "return", date: "2027-04-21", days: 201 }]);
    const scheduled = { id: "r", event_type: "RETURN_FROM_LEAVE", effective_date: "2027-04-21" } as Employee["next_event"];
    expect(nextItems(person({ status: "ON_LEAVE", expected_return_date: "2027-04-21", next_event: scheduled }), TODAY, 60).map((i) => i.kind)).toEqual(["event"]);
    expect(nextItems(person({ status: "ACTIVE", expected_return_date: "2027-04-21" }), TODAY, 60)).toEqual([]);
  });
});

test("tenure counts whole months; a future or missing hire date has none", () => {
  expect(tenure("2021-03-02", TODAY)).toEqual({ years: 5, months: 7 });
  expect(tenure("2021-10-03", TODAY)).toEqual({ years: 4, months: 11 });
  expect(tenure("2026-10-02", TODAY)).toEqual({ years: 0, months: 0 });
  expect(tenure("2026-11-01", TODAY)).toBeNull();
  expect(tenure(null, TODAY)).toBeNull();
});

test("the number jump needs exactly one equal employee number, in any case and shape", () => {
  const rows = [person({ id: "a", employee_number: "HK-4112" }), person({ id: "b", employee_number: "HK-41120" }), person({ id: "c", employee_number: "0042" })];
  expect(exactNumber(rows, " hk-4112 ")?.id).toBe("a");
  expect(exactNumber(rows, "0042")?.id).toBe("c");
  expect(exactNumber(rows, "HK-411")).toBeNull();
  expect(exactNumber([...rows, person({ id: "d", employee_number: "0042" })], "0042")).toBeNull();
  expect(exactNumber(rows, "  ")).toBeNull();
});

// Edges the mutation run found unpinned (npm run mutants).
test("only the actions the server lists are offered, in the record's order, never onboarding", () => {
  type Allowed = Parameters<typeof offeredVerbs>[0]["allowed_events"];
  const ev = (...types: string[]) => types.map((event_type) => ({ event_type })) as unknown as Allowed;
  expect(offeredVerbs({ allowed_events: ev("CONTRACT_RENEWAL", "ONBOARD", "TRANSFER"), allowed_scheduled_events: ev("PROMOTE") })).toEqual(["TRANSFER", "PROMOTE", "CONTRACT_RENEWAL"]);
  expect(offeredVerbs({ allowed_events: ev(), allowed_scheduled_events: ev("LEAVE_OF_ABSENCE", "RETURN_FROM_LEAVE") })).toEqual(["LEAVE_OF_ABSENCE", "RETURN_FROM_LEAVE"]);
  expect(offeredVerbs({ allowed_events: ev(), allowed_scheduled_events: ev() })).toEqual([]);
});

test("chip edges: no URL value, adding a chip, each review flag alone, a missing contract total, the window's last day", () => {
  expect(parseReview(undefined)).toEqual([]);
  expect(toggleReview(["identity"], "failed")).toEqual(["identity", "failed"]);
  expect(listQuery({ status: "current", review: ["identity"] }, TODAY, 60)).toMatchObject({ identity_review_required: true, lifecycle_apply_failed: undefined, contract_ending_before: undefined });
  expect(reviewTotals([undefined, 17, 3, 21, 7, 1]).contractSoon).toBeUndefined();
  expect(reviewTotals([2, undefined, 3, 21, 7, 1]).contractSoon).toBeUndefined();
  expect(nextItems(person({ contract_end_date: "2026-12-01" }), TODAY, 60)).toEqual([{ kind: "contract", date: "2026-12-01", days: 60 }]);
  expect(exactNumber([person({ id: "x", employee_number: null })], "0042")).toBeNull();
});

test("retention runs 3 years from the exit date, the day after the last working day", () => {
  expect(retentionEnd("2025-11-16")).toBe("2028-11-17");
  expect(retentionEnd("2024-02-29")).toBe("2027-03-01");
});


test("department review survives the URL and uses the shared list and bulk selection filter", () => {
  expect(parseReview("department")).toEqual(["department"]);
  const f = { status: "current", review: parseReview("department") } as const;
  expect(listQuery(f, TODAY, 60)).toMatchObject({ department_missing: true });
  expect(facetQueries(f, TODAY, 60).list).toMatchObject({ department_missing: true });
  expect(facetQueries(f, TODAY, 60).review).not.toHaveProperty("department_missing");
});
