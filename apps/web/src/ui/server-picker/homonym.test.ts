import { expect, test } from "vitest";
import { homonymOf, suffixMatches } from "./homonym";

const a = { id: "1", name: "Kim Minjun", code: "HK-0045" };
const b = { id: "2", name: "Kim Minjun ", code: "HK-0203" };
const c = { id: "3", name: "Jeong Haneul", code: "HK-0112" };

test("namesakes are every option with the same (trimmed) name", () => {
  expect(homonymOf([a, b, c], a)).toEqual([a, b]);
  expect(homonymOf([a, b, c], c)).toEqual([c]);
  expect(homonymOf([a, b, c], undefined)).toEqual([]);
});

test("only the chosen person's last four characters confirm", () => {
  expect(suffixMatches(a, "0045")).toBe(true);
  expect(suffixMatches(a, " 00 45")).toBe(true);
  expect(suffixMatches(a, "0203")).toBe(false);
  expect(suffixMatches(a, "045")).toBe(false);
  expect(suffixMatches({ id: "x", name: "n" }, "")).toBe(false);
});
