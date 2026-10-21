import { expect, test } from "vitest";
import { renewBatches, renewedEnd, tallyChoices } from "./renew";

test("a renewal runs the same term from the day after the end; one batch per answer and end; leave is never a batch", () => {
  expect(renewedEnd("2026-10-20", 12)).toBe("2027-10-20");
  expect(renewedEnd("2026-02-28", 12)).toBe("2027-02-28");
  const people = [{ id: "a", end: "2026-10-20" }, { id: "b", end: "2026-10-20" }, { id: "c", end: "2026-11-15" }, { id: "d", end: "2026-10-20" }, { id: "e", end: null }, { id: "f", end: "2026-10-31" }];
  const choices = { a: "renew", b: "convert", c: "renew", d: "leave", e: "renew", f: "convert" } as const;
  expect(renewBatches(people, choices, 12)).toEqual([
    { choice: "renew", effective: "2026-10-21", end: "2027-10-20", ids: ["a"] },
    { choice: "renew", effective: "2026-11-16", end: "2027-11-15", ids: ["c"] },
    { choice: "convert", effective: "2026-10-21", ids: ["b"] },
    { choice: "convert", effective: "2026-11-01", ids: ["f"] },
  ]);
  expect(tallyChoices(people, { a: "renew", b: "convert" })).toEqual({ renew: 1, convert: 1, leave: 0, open: 4 });
});
