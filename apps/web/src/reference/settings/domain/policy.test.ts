import { describe, expect, it } from "vitest";
import { hqNeedsSomeoneElse, policyRouted } from "./policy";

describe("regression W09: hqNeedsSomeoneElse (decisions #26 item d)", () => {
  // regression (W09): under none a solo HR confirmer is never told to find someone else.
  it("lets the HR confirmer finish the HQ tier under none", () => {
    expect(hqNeedsSomeoneElse(false, "me", "me")).toBe(false);
  });
  it("keeps refusing the same person under route", () => {
    expect(hqNeedsSomeoneElse(true, "me", "me")).toBe(true);
  });
  it("lets someone else confirm under route", () => {
    expect(hqNeedsSomeoneElse(true, "hr", "me")).toBe(false);
    expect(hqNeedsSomeoneElse(true, null, "me")).toBe(false);
  });
});

describe("policyRouted", () => {
  it("is route only when the tenant says route; missing or unread is the default none", () => {
    expect(policyRouted([{ key: "approval.policy.exit", value: "route" }], "exit")).toBe(true);
    expect(policyRouted([{ key: "approval.policy.exit", value: "none" }], "exit")).toBe(false);
    expect(policyRouted([{ key: "approval.policy.org_structure", value: "route" }], "exit")).toBe(false);
    expect(policyRouted(undefined, "exit")).toBe(false);
  });
});
