import { expect, test } from "vitest";
import { canonical } from "./canonical";

test("keys sorted at every depth, no whitespace, values as JSON (the server hashes the same text)", () => {
  expect(canonical({ phone: "010", hire_date: "2026-10-05", base_pay: 3000000, job: null, careers: [{ to: "b", from: "a" }] })).toBe(
    '{"base_pay":3000000,"careers":[{"from":"a","to":"b"}],"hire_date":"2026-10-05","job":null,"phone":"010"}',
  );
  expect(canonical({ name: "정입사" })).toBe('{"name":"정입사"}');
});
