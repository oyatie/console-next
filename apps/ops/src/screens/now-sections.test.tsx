// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { OpsHomeSnapshot, OpsLive } from "../lib/api";
import { NowLowerSections } from "./now-sections";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

function makeHome(limits: OpsHomeSnapshot["cost"][number]["limits"]): OpsHomeSnapshot {
  return {
    evaluated_at: "2026-11-21T21:40:00Z",
    verdict: { text: "All quiet · 0 pages · evidence fresh", worst: "Healthy" },
    worklist: [],
    changing: [],
    budgets: [],
    data_safety: [],
    cost: [
      {
        key: "oci-ap-seoul-1",
        mtd: { state: "Verified", value: 184.2, unit: "USD", source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
        lag_s: { state: "Verified", value: 900, unit: "s", source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
        billed_skus: { state: "Verified", value: 14, unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
        limits,
      },
    ],
    evidence: {
      counts: { Verified: 5, Monitoring: 1, Stale: 0, Unknown: 0 },
      sources: [
        {
          name: "config-bundle",
          kind: "bundle",
          producer: "deploy-bundle",
          interval: 60,
          observed_at: "2026-11-21T21:25:00Z",
          age: 900,
          state: "Stale",
          reason: "stale 15m",
        },
      ],
    },
  };
}

function renderSections(home: OpsHomeSnapshot, liveStatus: OpsLive = "Live", disconnectedAgeS = 0) {
  return renderToStaticMarkup(
    <NowLowerSections
      home={home}
      liveStatus={liveStatus}
      disconnectedAgeS={disconnectedAgeS}
      evaluatedAt="2026-11-21 21:40:00 UTC"
    />,
  );
}

describe("NowLowerSections Cost FreeTierMeter truth & disconnect staleness", () => {
  test("renders Meter only when both used and limit are known positive numbers", () => {
    const html = renderSections(
      makeHome([
        {
          key: "Object Storage Free Tier",
          used: { state: "Verified", value: 14, unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
          limit: { state: "Verified", value: 20, unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
          warning_ratio: { state: "Verified", value: 0.8, unit: null, source: "evaluator", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
        },
      ]),
    );
    expect(html).toContain('role="meter"');
    expect(html).toContain("14 / 20");
    expect(html).not.toContain("/ 100");
  });

  test("does NOT render Meter or fabricate / 100 when limit is Unknown", () => {
    const html = renderSections(
      makeHome([
        {
          key: "Egress Free Tier",
          used: { state: "Verified", value: 14, unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
          limit: { state: "Unknown", unit: null, source: "textfile", observed_at: null, age_s: 0, reason: "quota not instrumented" },
          warning_ratio: { state: "Verified", value: 0.8, unit: null, source: "evaluator", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
        },
      ]),
    );
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("100");
    expect(html).toContain("14");
    expect(html).toContain("Unknown: quota not instrumented");
  });

  test("does NOT render Meter or fabricate 0 when used is Unknown", () => {
    const html = renderSections(
      makeHome([
        {
          key: "Object Storage Free Tier",
          used: { state: "Unknown", unit: null, source: "textfile", observed_at: null, age_s: 0, reason: "source down" },
          limit: { state: "Verified", value: 20, unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
          warning_ratio: { state: "Verified", value: 0.8, unit: null, source: "evaluator", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
        },
      ]),
    );
    expect(html).not.toContain('role="meter"');
    expect(html).toContain("Unknown: source down");
    expect(html).toContain("20");
  });

  test("marks Evidence counts and source states stale with strike-through when SSE disconnected", () => {
    const html = renderSections(makeHome([]), "Reconnecting", 12);
    expect(html).toContain("<s");
    expect(html).toContain("Unknown: stale 12s");
  });
});
