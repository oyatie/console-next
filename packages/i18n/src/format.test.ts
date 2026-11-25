import { afterEach, beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog } from "./index";
import { fmtDate, fmtDateInput, fmtDateShortWeekday, fmtDateTime, fmtDateTimeShort, fmtKrw, fmtMonth, fmtWeekday, parseTimestamp } from "./format";

beforeAll(() => loadCatalog("ko"));
afterEach(() => i18n.set("ko"));

test("parses RFC 3339 and rejects anything else", () => {
  expect(parseTimestamp("2026-09-30T05:45:53Z")?.toISOString()).toBe("2026-09-30T05:45:53.000Z");
  expect(parseTimestamp("nope")).toBeNull();
  expect(parseTimestamp(null)).toBeNull();
});

test("Korean dates and input use the app format with optional weekday", () => {
  expect(fmtDate("2026-09-30T20:00:00Z")).toBe("2026. 10. 01.");
  expect(fmtDate("2026-01-01")).toBe("2026. 01. 01.");
  expect(fmtDate("2026-10-20", { weekday: "short" })).toBe("2026. 10. 20. (화)");
  expect(fmtDate("2026-02-30")).toBe("—");
  expect(fmtDateInput("2026-10-20")).toBe("2026. 10. 20.");
  expect(fmtDateShortWeekday("2026-11-20")).toBe(`11-20 (${fmtWeekday("2026-11-20")})`);
  expect(fmtDateShortWeekday("")).toBe("");
  expect(fmtWeekday("2026-10-20")).toBe("화");
  expect(fmtMonth("2026-10")).toBe("2026년 10월");
});

test("English dates and input follow the app language, not the browser language", () => {
  i18n.set("en");
  expect(fmtDate("2026-10-20")).toBe("10/20/2026");
  expect(fmtDate("2026-10-20", { weekday: "short" })).toBe("Tue, 10/20/2026");
  expect(fmtDateInput("2026-10-20")).toBe("10/20/2026");
  expect(fmtDateShortWeekday("2026-11-20")).toBe("Fri, 11/20");
  expect(fmtWeekday("2026-10-20")).toBe("Tue");
  expect(fmtMonth("2026-10")).toBe("October 2026");
});

test("the month-name style draws a business month without its year, and nothing for a month that is not one", () => {
  i18n.set("en");
  expect(fmtMonth("2026-10", "name")).toBe("October");
  expect(fmtMonth("2026-01", "name")).toBe("January");
  expect(fmtMonth("2026-13", "name")).toBe("—");
});

test("the ISO day style draws business dates as YYYY-MM-DD in Korean time, and a caller may pin the locale style", () => {
  const localeStyle = i18n.dateStyle;
  try {
    i18n.dateStyle = () => "iso";
    expect(fmtDate("2026-11-06")).toBe("2026-11-06");
    expect(fmtDate("2026-09-30T20:00:00Z")).toBe("2026-10-01");
    expect(fmtDate("2026-11-10", { weekday: "short" })).toBe(`2026-11-10 (${fmtWeekday("2026-11-10")})`);
    expect(fmtDate("2026-11-06", { style: "locale" })).toBe("2026. 11. 06.");
    expect(fmtDate("2026-02-30")).toBe("—");
    i18n.set("en");
    expect(fmtDate("2026-11-10", { weekday: "short" })).toBe("Tue, 2026-11-10");
    expect(fmtDate("2026-11-06", { style: "locale" })).toBe("11/06/2026");
  } finally {
    i18n.dateStyle = localeStyle;
  }
  expect(fmtDate("2026-11-06")).toBe("11/06/2026");
});

test("all timestamps use Korean business time, 24-hour time and a KST zone label", () => {
  expect(fmtDateTime("2026-09-30T05:45:53Z")).toBe("2026. 09. 30. 14:45 KST");
  expect(fmtDateTime("2026-10-02T07:40:00Z")).toBe("2026. 10. 02. 16:40 KST");
  expect(fmtDateTime(undefined)).toBe("—");
});

test("English timestamps keep the same KST instant and label", () => {
  i18n.set("en");
  expect(fmtDateTime("2026-09-30T05:45:53Z")).toBe("09/30/2026, 14:45 KST");
});

test("missing money is 산정 불가, never 0", () => {
  expect(fmtKrw(null)).toBe("산정 불가");
  expect(fmtKrw("3000000")).toBe("3,000,000원");
});

test("the period-unlock formatter export remains compatible", () => {
  expect(fmtDateTimeShort).toBe(fmtDateTime);
  expect(fmtDateTimeShort("2026-10-02T07:40:00Z")).toBe("2026. 10. 02. 16:40 KST");
});
