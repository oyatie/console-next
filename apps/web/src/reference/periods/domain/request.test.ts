import { describe, expect, it } from "vitest";
import { requestState, shownRequest, toDecide, type RequestState } from "./request";

describe("unlock requests", () => {
  const now = Date.parse("2026-10-13T00:00:00Z");
  const req = (status: RequestState, until: string, canDecide = false) => ({ status, relockAt: until, canDecide });
  const later = "2026-10-14T00:00:00Z";
  it("reads a waiting request past its window as expired, and a decision as it was sent", () => {
    expect(requestState(req("PENDING", later), now)).toBe("PENDING");
    expect(requestState(req("PENDING", "2026-10-13T00:00:00Z"), now)).toBe("EXPIRED");
    expect(requestState(req("REJECTED", "2026-10-12T00:00:00Z"), now)).toBe("REJECTED");
    expect(requestState(req("APPROVED", later), now)).toBe("APPROVED");
  });
  it.each([
    ["PENDING", later, true],
    ["REJECTED", later, true],
    ["EXPIRED", later, true],
    ["PENDING", "2026-10-12T00:00:00Z", true],
    ["APPROVED", later, false],
    ["SUPERSEDED", later, false],
  ] as const)("shows a %s request (window %s) on the lock: %s", (status, until, shown) => {
    expect(shownRequest({ unlockRequest: req(status, until) }, now) !== undefined).toBe(shown);
    expect(shownRequest({}, now)).toBeUndefined();
  });
  it("puts only waiting requests the viewer may decide in their queue", () => {
    const locks = [
      { id: "mine", unlockRequest: req("PENDING", later, true) },
      { id: "theirs", unlockRequest: req("PENDING", later, false) },
      { id: "expired", unlockRequest: req("PENDING", "2026-10-12T00:00:00Z", true) },
      { id: "refused", unlockRequest: req("REJECTED", later, true) },
      { id: "none" },
    ];
    expect(toDecide(locks, now).map((l) => l.id)).toEqual(["mine"]);
  });
});
