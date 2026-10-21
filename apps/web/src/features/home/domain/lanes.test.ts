import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { addDays, changeLanes, daysUntil } from "./lanes";

type Change = components["schemas"]["OrgChangeSummary"];
const change = (id: string, status: Change["status"], effectiveDate: string, draftedBy = "me") => ({ id, status, effectiveDate, draftedBy }) as Change;
const ids = (cs: Change[]) => cs.map((c) => c.id);
const today = "2026-10-02";

test("calendar-day arithmetic crosses months and years", () => {
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(daysUntil("2026-10-12", today)).toBe(10);
  expect(daysUntil("2026-09-30", today)).toBe(-2);
  expect(daysUntil(today, today)).toBe(0);
});

test("an apply holder sees every approved change, due or scheduled, once and earliest first", () => {
  const own = [change("d", "DRAFT", "2026-11-01"), change("a1", "APPROVED", "2026-10-02"), change("p", "IN_APPROVAL", "2026-10-20")];
  const approved = [change("a1", "APPROVED", "2026-10-02"), change("a0", "APPROVED", "2026-09-28", "other"), change("s", "APPROVED", "2026-10-09", "other")];
  const lanes = changeLanes(own, approved, { me: "me", canApply: true, today });
  expect(ids(lanes.due)).toEqual(["a0", "a1"]);
  expect(ids(lanes.scheduled)).toEqual(["s"]);
  expect(ids(lanes.mine)).toEqual(["d"]);
  expect(ids(lanes.waiting)).toEqual(["p"]);
});

test("a drafter who cannot apply waits on a due change; others' changes are not theirs", () => {
  const own = [change("a", "APPROVED", "2026-10-01"), change("r", "REJECTED", "2026-10-01"), change("x", "SETTLING", "2026-10-01")];
  const lanes = changeLanes(own, [], { me: "me", canApply: false, today });
  expect(ids(lanes.waiting)).toEqual(["a"]);
  expect(ids(lanes.due)).toEqual([]);
  expect(ids(lanes.mine)).toEqual(["r", "x"]);
  expect(changeLanes([change("o", "DRAFT", today, "other")], [], { me: "me", canApply: true, today }).mine).toEqual([]);
});

test("a redrafted rejection leaves my turn, whatever became of the redraft", () => {
  const redraft = (id: string, status: Change["status"], of: string) => ({ ...change(id, status, today), supersedesId: of }) as Change;
  const own = [change("r1", "REJECTED", today), redraft("n1", "IN_APPROVAL", "r1"), change("r2", "REJECTED", today), redraft("n2", "APPLIED", "r2"), change("r3", "REJECTED", today)];
  const lanes = changeLanes(own, [], { me: "me", canApply: false, today });
  expect(ids(lanes.mine)).toEqual(["r3"]);
  expect(ids(lanes.waiting)).toEqual(["n1"]);
});
