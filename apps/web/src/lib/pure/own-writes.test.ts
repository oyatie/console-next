import { expect, test } from "vitest";
import { ownWrites } from "./own-writes";

test("a command read before this tab's own write to another field goes at the version that write produced", () => {
  const own = ownWrites();
  own.record("e1", "v0", "v1", ["emergency_contacts"]);
  own.record("e1", "v1", "v2", ["nationality"]);
  expect(own.base("e1", "v0", ["photo"])).toBe("v2");
  expect(own.base("e1", "v1", ["photo"])).toBe("v2");
});

test("regression: a write to the same field, another employee, or a version this tab never wrote stays as read (the server refuses it stale)", () => {
  const own = ownWrites();
  own.record("e1", "v0", "v1", ["emergency_contacts"]);
  own.record("e1", "v1", "v2", ["photo"]);
  expect(own.base("e1", "v0", ["emergency_contacts"])).toBe("v0");
  expect(own.base("e1", "v0", ["photo"])).toBe("v1");
  expect(own.base("e2", "v0", ["photo"])).toBe("v0");
  expect(own.base("e1", "x9", ["photo"])).toBe("x9");
});

test("an unchanged version (a request left for a second person) is no step; the record keeps only the latest steps", () => {
  const own = ownWrites(2);
  own.record("e1", "v0", "v0", ["hire_date"]);
  expect(own.base("e1", "v0", ["photo"])).toBe("v0");
  own.record("e1", "v0", "v1", ["a"]);
  own.record("e1", "v1", "v2", ["a"]);
  own.record("e1", "v2", "v3", ["a"]);
  expect(own.base("e1", "v0", ["b"])).toBe("v0");
  expect(own.base("e1", "v1", ["b"])).toBe("v3");
});
