import { expect, test } from "vitest";
import { todayKst } from "./today";

test("today is the Korean calendar day", () => {
  expect(todayKst(new Date("2026-09-30T15:30:00Z"))).toBe("2026-10-01"); // 00:30 KST
  expect(todayKst(new Date("2026-09-30T14:59:00Z"))).toBe("2026-09-30"); // 23:59 KST
});
