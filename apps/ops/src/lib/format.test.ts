// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import {
  formatBudgetPercent,
  formatBurn,
  formatCount,
  formatDuration,
  formatObservedPrimitive,
  formatPercent,
  formatUsd,
  formatUtcShort,
  formatUtcTimestamp,
} from "./format";

describe("ops formatting helpers", () => {
  test("formats UTC timestamps with trailing Z and rejects banned placeholders", () => {
    expect(formatUtcTimestamp("2026-11-21T21:43:00.000Z")).toBe("2026-11-21T21:43:00Z");
    expect(formatUtcShort("2026-11-21T21:43:00Z")).toBe("11-21 21:43Z");
    const missing = formatUtcTimestamp(null);
    expect(missing).toContain("Unknown:");
    expect(missing).not.toMatch(/No data|N\/A|^—$/);
  });

  test("formats durations, counts, burn rates, USD, and Exhausted only at 0", () => {
    expect(formatDuration(14)).toBe("14s");
    expect(formatDuration(130)).toBe("2m");
    expect(formatDuration(7800)).toBe("2h 10m");
    expect(formatDuration(93600)).toBe("1d 2h");
    expect(formatCount(1460)).toBe("1,460");
    expect(formatBurn(1.25)).toBe("1.3x");
    expect(formatBurn(0)).toBe("0.0x");
    expect(formatUsd(42.5)).toBe("$42.50 USD");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.5)).toBe("0.5%");
    expect(formatBudgetPercent(0)).toBe("Exhausted");
    expect(formatBudgetPercent(0.5)).toBe("0.5%");
    expect(formatObservedPrimitive(true, null)).toBe("Frozen");
    expect(formatObservedPrimitive(false, null)).toBe("Open");
    expect(formatObservedPrimitive(Number.NaN, "%")).toBe("Unknown: not instrumented");
    expect(formatObservedPrimitive(Number.POSITIVE_INFINITY, "s")).toBe("Unknown: not instrumented");
    expect(formatObservedPrimitive(Number.NEGATIVE_INFINITY, null)).toBe("Unknown: not instrumented");
    expect(formatObservedPrimitive(Number.NaN, "%")).not.toContain("NaN");
  });
});
