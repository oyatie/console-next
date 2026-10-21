import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "./index";
import { fmtDate, fmtDateTimeShort, fmtKrw, fmtStamp, parseTimestamp } from "./format";

// Screens render after their catalog loads (the router awaits it); so do these.
beforeAll(() => loadCatalog("ko"));

test("parses RFC 3339 and rejects anything else", () => {
  expect(parseTimestamp("2026-09-30T05:45:53Z")?.toISOString()).toBe("2026-09-30T05:45:53.000Z");
  expect(parseTimestamp("nope")).toBeNull();
  expect(parseTimestamp(null)).toBeNull();
});

test("dates render in Asia/Seoul, not the viewer's zone", () => {
  // 2026-09-30 20:00 UTC is already Oct 1 in Seoul.
  expect(fmtDate("2026-09-30T20:00:00Z")).toContain("10. 01");
  // Plain dates are calendar days in Seoul and never shift.
  expect(fmtDate("2026-01-01")).toContain("01. 01");
});

test("missing money is 산정 불가, never 0", () => {
  expect(fmtKrw(null)).toBe("산정 불가");
  expect(fmtKrw("3000000")).toBe("3,000,000원");
});

test("the short date-time is month, day and 24-hour time in Seoul, without the year", () => {
  // 05:45 UTC is 14:45 in Seoul.
  const s = fmtDateTimeShort("2026-09-30T05:45:53Z");
  expect(s).toContain("9. 30.");
  expect(s).toContain("14:45");
  expect(s).not.toContain("2026");
  expect(fmtDateTimeShort(null)).toBe("—");
});

test("a ledger stamp is the full date and 24-hour time in Seoul", () => {
  // 07:40 UTC is 16:40 in Seoul.
  expect(fmtStamp("2026-10-02T07:40:00Z")).toBe("2026. 10. 02. 16:40");
  expect(fmtStamp(undefined)).toBe("—");
});
