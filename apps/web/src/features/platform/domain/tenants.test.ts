import { expect, test } from "vitest";
import { MOVES, TARGET, inView, matches } from "./tenants";

const org = { name: "한빛정밀", slug: "hanbit", group_name: "Acme Group", status: "SUSPENDED" as const };

test("views split by status; all holds everything", () => {
  expect(inView(org, "suspended")).toBe(true);
  expect(inView(org, "active")).toBe(false);
  expect(inView(org, "all")).toBe(true);
});

test("search matches the name, slug or group, ignoring case and surrounding spaces", () => {
  expect(matches(org, "한빛")).toBe(true);
  expect(matches(org, " HAN ")).toBe(true);
  expect(matches(org, "acme")).toBe(true);
  expect(matches(org, "")).toBe(true);
  expect(matches({ ...org, group_name: null }, "acme")).toBe(false);
});

test("every offered move leads away from the current status", () => {
  for (const [from, moves] of Object.entries(MOVES)) for (const m of moves) expect(TARGET[m]).not.toBe(from);
  expect(MOVES.ARCHIVED).toEqual(["resume"]);
});
