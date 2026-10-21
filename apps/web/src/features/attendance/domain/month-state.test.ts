import { expect, test } from "vitest";
import { closed, pageState } from "./month-state";

const open = { state: "OPEN" as const };
const shut = (lock_id: string | null) => ({ state: "CLOSED" as const, lock_id });
const reopened = (lock_id: string, relock_at: string) => ({ state: "REOPENED" as const, lock_id, relock_at });

test("closed anywhere is closed, with the lock to unlock and how many people it holds", () => {
  expect(pageState([open, reopened("l1", "2026-10-20T00:00:00Z"), shut(null), shut("l2")])).toEqual({ state: "CLOSED", lockId: "l2", relockAt: null, people: 2 });
  expect(pageState([shut(null)])).toEqual({ state: "CLOSED", lockId: null, relockAt: null, people: 1 });
});

test("reopened shows the earliest re-lock; nothing closed is open", () => {
  expect(pageState([open, reopened("l1", "2026-10-21T00:00:00Z"), reopened("l1", "2026-10-20T00:00:00Z")])).toEqual({ state: "REOPENED", lockId: "l1", relockAt: "2026-10-20T00:00:00Z", people: 2 });
  expect(pageState([open, open])).toEqual({ state: "OPEN", lockId: null, relockAt: null, people: 2 });
  expect(pageState([])).toEqual({ state: "OPEN", lockId: null, relockAt: null, people: 0 });
});

test("only a closed month refuses writes", () => {
  expect([closed(open), closed(shut("l")), closed(reopened("l", "x")), closed(undefined)]).toEqual([false, true, false, false]);
});
