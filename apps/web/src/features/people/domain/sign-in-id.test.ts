import { expect, test } from "vitest";
import { changeProblem, loginProblem, romanizeName, suggestLogin } from "./sign-in-id";

test("a login follows the server's mailbox rule", () => {
  expect(loginProblem(" Hong.GilDong ")).toBeNull();
  expect(loginProblem("e-000123")).toBeNull();
  expect(loginProblem("a".repeat(32))).toBeNull();
  expect(loginProblem("")).toBe("empty");
  for (const bad of [".hong", "hong.", "ho..ng", "ho_-ng", "ho ng", "ho@ng", "a".repeat(33)]) expect(loginProblem(bad), bad).toBe("invalid");
  for (const korean of ["홍길동", "ｈｏｎｇ"]) expect(loginProblem(korean), korean).toBe("nonAscii");
});

test("a change names its first problem in the order the form reads", () => {
  const ok = { current: "hong@acme", next: "hong.gildong", date: "2026-10-09", today: "2026-10-09", reason: "NAME_CHANGE", needsNote: false, note: "" };
  expect(changeProblem(ok)).toBeNull();
  expect(changeProblem({ ...ok, next: "HONG" })).toBe("unchanged");
  expect(changeProblem({ ...ok, next: "홍" })).toBe("nonAscii");
  expect(changeProblem({ ...ok, date: "" })).toBe("date");
  expect(changeProblem({ ...ok, date: "2026-10-10" })).toBe("future");
  expect(changeProblem({ ...ok, reason: null })).toBe("reason");
  expect(changeProblem({ ...ok, needsNote: true })).toBe("note");
});

test("a Korean name romanises as surname.given, with the family names people write", () => {
  expect(romanizeName("홍길동")).toBe("hong.gildong");
  expect(romanizeName("김철수")).toBe("kim.cheolsu");
  expect(romanizeName("이영희")).toBe("lee.yeonghui");
  expect(romanizeName("박지성")).toBe("park.jiseong");
  expect(romanizeName("최윤")).toBe("choi.yun");
  expect(romanizeName("John Smith")).toBe("john.smith");
  expect(romanizeName("홍")).toBeNull();
  expect(romanizeName("김 철수")).toBeNull();
});

test("an invite suggests the romanised name, else the employee number, else nothing", () => {
  expect(suggestLogin("홍길동", "E-000123")).toBe("hong.gildong");
  expect(suggestLogin("홍", "E-000123")).toBe("e-000123");
  expect(suggestLogin("홍", null)).toBe("");
});
