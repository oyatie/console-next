import { describe, expect, it } from "vitest";
import { phaseBand as configuredPhaseBand, receiptDuration } from "./phase";

const phaseBand = (phase: string, at: string | null, now: number) => configuredPhaseBand(phase, at, now, 7 * 86400000);

describe("phase band (BL-016)", () => {
  const start = "2026-10-09T00:00:00Z";
  const now = Date.parse(start);
  it("shows setup without a start date", () => {
    expect(phaseBand("SETUP", null, now)).toBe("setup");
  });
  it("shows the reminder for the first seven days, with an exclusive end", () => {
    expect(phaseBand("OPERATING", start, now)).toBe("started");
    expect(phaseBand("OPERATING", start, now + 7 * 86400000 - 1)).toBe("started");
    expect(phaseBand("OPERATING", start, now + 7 * 86400000)).toBeNull();
  });
  it("keeps the operating reminder despite client clock skew", () => {
    expect(phaseBand("OPERATING", start, now - 1)).toBe("started");
  });
  it("omits legacy, invalid and unknown phases", () => {
    expect(phaseBand("OPERATING", null, now)).toBeNull();
    expect(phaseBand("OPERATING", "invalid", now)).toBeNull();
    expect(phaseBand("UNKNOWN", start, now)).toBeNull();
  });
});

it("reads the receipt duration from settings without a client default", () => {
  expect(receiptDuration([{ key: "onboarding.receipt_days", value: 2 }])).toBe(2 * 86400000);
  for (const value of [undefined, "7", 0, -1, NaN, Infinity]) expect(receiptDuration([{ key: "onboarding.receipt_days", value }])).toBe(0);
  expect(receiptDuration(undefined)).toBe(0);
});
