// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ObservedValue } from "./observed-value";

describe("ObservedValue truth and staleness rendering", () => {
  test("renders Verified value without strike-through", () => {
    const html = renderToStaticMarkup(
      <ObservedValue
        observation={{
          state: "Verified",
          value: "Healthy",
          unit: null,
          source: "victoriametrics",
          observed_at: "2026-11-21T21:43:00Z",
          age_s: 12,
        }}
        asBadge
      />,
    );
    expect(html).toContain("Healthy");
    expect(html).not.toContain("<s ");
    expect(html).not.toContain("</s>");
    expect(html).not.toContain("Unknown:");
  });

  test("renders Unknown with explicit reason and never banned placeholder strings", () => {
    const html = renderToStaticMarkup(
      <ObservedValue
        observation={{
          state: "Unknown",
          value: null,
          unit: null,
          source: "alertmanager",
          observed_at: null,
          age_s: 0,
          reason: "source down",
        }}
      />,
    );
    expect(html).toContain("Unknown: source down");
    expect(html).not.toMatch(/No data|N\/A/);
    expect(html).not.toContain("Healthy");
  });

  test("strikes through value on Stale state and on SSE Reconnecting", () => {
    const staleHtml = renderToStaticMarkup(
      <ObservedValue
        observation={{
          state: "Stale",
          value: "Synced",
          unit: null,
          source: "bundle",
          observed_at: "2026-11-21T21:30:00Z",
          age_s: 180,
          reason: "stale 3m",
        }}
      />,
    );
    expect(staleHtml).toContain("<s");
    expect(staleHtml).toContain("Synced");
    expect(staleHtml).toContain("Stale: stale 3m");

    const disconnectHtml = renderToStaticMarkup(
      <ObservedValue
        observation={{
          state: "Verified",
          value: "Synced",
          unit: null,
          source: "bundle",
          observed_at: "2026-11-21T21:43:00Z",
          age_s: 10,
        }}
        liveStatus="Reconnecting"
        disconnectedAgeS={45}
      />,
    );
    expect(disconnectHtml).toContain("<s");
    expect(disconnectHtml).toContain("Unknown: stale 45s");
  });
});
