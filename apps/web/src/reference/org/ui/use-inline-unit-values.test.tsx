// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { useInlineUnitValues } from "./use-inline-unit-values";

const state = vi.hoisted(() => ({ date: "2026-11-04", reason: "", routed: false, ready: true }));
vi.mock("../../../lib/pure/today", () => ({ todayKst: () => "2026-11-04" }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isSuccess: state.ready, data: { items: [{ key: "approval.policy.org_structure", value: state.routed ? "route" : "none" }] } }) }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => [typeof initial === "function" ? { effectiveDate: state.date, reason: state.reason } : initial, vi.fn()] }));

test.each([
  [false, false, "2026-11-03", "Growth", false],
  [false, false, "", "Growth", false],
  [false, false, "2026-11-04", "   ", true],
  [false, true, "2026-11-04", "   ", false],
  [false, true, "2026-11-04", "Growth", true],
  [false, false, "2026-12-01", "", true],
  [true, true, "", "", true],
])("setup=%s routed=%s date=%s note=%s valid=%s", (setup, routed, date, reason, valid) => {
  Object.assign(state, { routed, date, reason, ready: true });
  function Probe() {
    expect(useInlineUnitValues(setup).valid).toBe(valid);
    return null;
  }
  renderToStaticMarkup(<Probe />);
});


test.each([false, true])("unknown policy requires a note only after setup=%s", setup => {
  Object.assign(state, { date: "2026-11-04", reason: "", routed: false, ready: false });
  function Probe() {
    const values = useInlineUnitValues(setup);
    expect(values.required).toBe(!setup);
    expect(values.valid).toBe(setup);
    return null;
  }
  renderToStaticMarkup(<Probe />);
});
