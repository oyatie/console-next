import { expect, test } from "vitest";
import { changes, EMPTY, needsSecond } from "./corrections";

test("a correction sends only what was typed and differs, in the server's form", () => {
  const current = { name: "정하늘", phone: "+8210-1234-0001", hire_date: "2026-01-02", employment_type: "REGULAR", base_pay: "3000000" };
  expect(changes(current, { ...EMPTY })).toEqual({});
  expect(changes(current, { ...EMPTY, name: " 정하늘 ", phone: "010-1234-0001" })).toEqual({});
  expect(changes(current, { ...EMPTY, phone: "010-1234-0002", base_pay: "3,200,000" })).toEqual({ phone: "+821012340002", base_pay: "3200000" });
});

test("dated or paid facts wait for a second person; a name or phone does not", () => {
  expect(needsSecond({ name: "정하늘" })).toBe(false);
  expect(needsSecond({ phone: "+8210-1234-0002", hire_date: "2026-01-03" })).toBe(true);
});
