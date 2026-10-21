import { expect, test } from "vitest";
import { repsMode, repsReady } from "./record-values";

test("adding a second representative asks how they represent; the single mode is never carried over", () => {
  const one = { names: ["홍길동"], leaving: [false], added: ["한지원"], mode: "SINGLE" as const };
  expect(repsReady(one, ["홍길동"], "SINGLE")).toBe(false);
  expect(repsReady({ ...one, mode: "SEVERAL" }, ["홍길동"], "SINGLE")).toBe(true);
  expect(repsReady({ names: ["홍길동"], leaving: [true], added: [], mode: null }, ["홍길동"], "SINGLE")).toBe(false);
  expect(repsMode(one)).toBeNull();
  expect(repsMode({ ...one, mode: "JOINT" })).toBe("JOINT");
});
