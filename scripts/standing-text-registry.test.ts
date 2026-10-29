import { expect, test } from "vitest";
import { mergeRegistry, readRegistry } from "./standing-text-registry.mjs";
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

test("attendance paste preview owns its refusal budget without raising either parent pin", () => {
  const { baseline, newScreens } = readRegistry();
  const sheet = "apps/web/src/features/attendance/ui/paste-preview.tsx#PastePreviewSheet";
  expect(newScreens[sheet]).toEqual({ FACT: 4, REFUSAL: 1, EMPTY: 0, LEGAL: 0, RECEIPT: 0, EXPLANATION: 0 });
  expect(baseline[sheet]).toBe(5);
  expect(baseline["apps/web/src/features/attendance/ui/attendance-page.tsx#DayPage"]).toBeLessThanOrEqual(85);
  expect(baseline["apps/web/src/features/attendance/ui/attendance-page.tsx#MonthPage"]).toBeLessThanOrEqual(91);
});
