// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { SORTS } from "./roster";
import { parseOrder } from "./roster-order";

test.each(SORTS)("accepts both server directions of %s", key => {
  expect(parseOrder(key)).toBe(key);
  expect(parseOrder(`-${key}`)).toBe(`-${key}`);
});
test.each([undefined, "", "salary", "-salary", "--name", "name desc"])("unknown URL order %s falls back to name", raw => {
  expect(parseOrder(raw)).toBe("name");
});
