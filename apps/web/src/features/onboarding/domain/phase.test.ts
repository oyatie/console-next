import { describe, expect, it } from "vitest";
import { phaseBand } from "./phase";

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
  it("omits legacy, invalid, future and unknown phases", () => {
    expect(phaseBand("OPERATING", null, now)).toBeNull();
    expect(phaseBand("OPERATING", "invalid", now)).toBeNull();
    expect(phaseBand("OPERATING", start, now - 1)).toBeNull();
    expect(phaseBand("UNKNOWN", start, now)).toBeNull();
  });
});
