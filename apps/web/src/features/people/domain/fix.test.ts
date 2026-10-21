import { expect, test } from "vitest";
import { dayDiff, isDate, normalizeDate, nextMonthFirst, periods, routeCounts, routeOf } from "./fix";

test("date helpers: difference, next month's first day, real calendar dates only", () => {
  expect(dayDiff("2019-03-14", "2019-03-04")).toBe(-10);
  expect(nextMonthFirst("2026-10-06")).toBe("2026-11-01");
  expect(nextMonthFirst("2026-12-31")).toBe("2027-01-01");
  expect(isDate("2026-02-29")).toBe(false);
  expect(isDate("2028-02-29")).toBe(true);
  expect(isDate("2026-13-01")).toBe(false);
});

test("a dated change closes the current period the day before and opens the new one", () => {
  expect(periods({ from: "2023-01-01", value: "주임" }, { from: "2026-11-01", value: "대리" })).toEqual([
    { from: "2023-01-01", to: "2026-10-31", value: "주임", state: "closing" },
    { from: "2026-11-01", to: null, value: "대리", state: "new" },
  ]);
  // From the hire date (D-17): the value before the change that set the current one comes first.
  expect(periods({ from: "2023-01-01", value: "주임" }, { from: "2026-11-01", value: "대리" }, { from: "2019-03-14", value: "사원" })[0]).toEqual(
    { from: "2019-03-14", to: "2022-12-31", value: "사원", state: "past" },
  );
  // No date for the current value (nothing recorded it): no earlier row is invented.
  expect(periods({ from: null, value: "주임" }, { from: "2026-11-01", value: "대리" }, { from: "2019-03-14", value: "사원" })).toHaveLength(2);
});

test("a multi-field correction routes each field by its class: high-risk to a second person, placement to a 발령", () => {
  expect(routeOf("sex")).toBe("now");
  expect(routeOf("birth_date")).toBe("second");
  expect(routeOf("unit")).toBe("act");
  expect(routeCounts(["name", "sex", "birth_date", "address", "unit"])).toEqual({ now: 3, second: 1, act: 1 });
});

test("a typed date takes the forms people type, and only real days", () => {
  expect(normalizeDate("2026.10.12")).toBe("2026-10-12");
  expect(normalizeDate("20261012")).toBe("2026-10-12");
  expect(normalizeDate("2026/1/5")).toBe("2026-01-05");
  expect(normalizeDate("2026-13-01")).toBeNull();
  expect(normalizeDate("abc")).toBeNull();
});
