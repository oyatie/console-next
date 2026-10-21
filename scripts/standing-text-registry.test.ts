import { expect, test } from "vitest";
import { mergeRegistry } from "./standing-text-registry.mjs";
import { ratchet } from "./check-standing-text.mjs";

test("disjoint lanes merge reductions while the existing ratchet refuses raised pins", () => {
  const { baseline } = mergeRegistry({ a: 2, b: 3 }, {}, [["one", { baseline: { a: 1 } }], ["two", { baseline: { b: 2 } }]]);
  expect(baseline).toEqual({ a: 1, b: 2 });
  expect(ratchet(baseline, baseline, { a: 2, b: 3 })).toEqual([]);
  expect(ratchet({ a: 3 }, { a: 3 }, { a: 2 })).toContain("a: standing-text baseline may only go down");
});

test("two lane files cannot silently overwrite the same pin", () => {
  expect(() => mergeRegistry({}, {}, [["one", { baseline: { a: 1 } }], ["two", { baseline: { a: 0 } }]])).toThrow(/overlapping/);
  expect(() => mergeRegistry({}, {}, [["one", []]])).toThrow(/invalid registry/);
  expect(() => mergeRegistry({}, {}, [["one", { baseline: { a: "1" } }]])).toThrow(/invalid baseline/);
});
