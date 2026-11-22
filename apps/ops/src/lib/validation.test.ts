// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { opsQueryKeys, type OpsMe } from "./api";
import { OpsContext } from "./ops-context";
import { SilencesTab } from "../screens/silences-tab";
import { buildDrillRequest, hasWatchdogMatcher, isValidUtcZTimestamp, parseMatcherLines, validateSilenceDraft } from "./validation";

const TS = "2026-11-21T21:40:00Z";
const ME_SILENCE: OpsMe = {
  evaluated_at: TS,
  operator: { person: "11111111-1111-4111-8111-111111111111", display_email: "oncall@cosskorea.invalid" },
  grants: [],
  allowed_actions: ["read.me", "read.alerts", "alert.silence"],
};

describe("ops client-side pre-checks", () => {
  test("isValidUtcZTimestamp validates strict RFC3339 UTC Z timestamps and calendar bounds", () => {
    expect(isValidUtcZTimestamp("2026-11-21T20:00:00Z")).toBe(true);
    expect(isValidUtcZTimestamp("2026-11-21T20:00:00.123Z")).toBe(true);
    expect(isValidUtcZTimestamp("2026-11-21T20:00:00+09:00")).toBe(false);
    expect(isValidUtcZTimestamp("2026-11-21 20:00:00Z")).toBe(false);
    expect(isValidUtcZTimestamp("2026-02-30T00:00:00Z")).toBe(false);
    expect(isValidUtcZTimestamp("")).toBe(false);
  });

  test("buildDrillRequest validates time UTC Z, rejects whitespace/placeholders, and omits tenant", () => {
    const okTime = buildDrillRequest({ repo: "1", drillType: "time", target: "2026-11-21T20:00:00Z", window: "window" });
    expect(okTime).toEqual({
      ok: true,
      payload: { repo: "1", drill_type: "time", target: "2026-11-21T20:00:00Z", window: "window" },
    });
    if (okTime.ok) expect(okTime.payload).not.toHaveProperty("tenant");

    expect(buildDrillRequest({ repo: "1", drillType: "time", target: "2026-11-21T20:00:00+09:00", window: "now" }).ok).toBe(false);
    expect(buildDrillRequest({ repo: "1", drillType: "time", target: "", window: "now" }).ok).toBe(false);
    expect(buildDrillRequest({ repo: "auto", drillType: "name", target: "", window: "window" })).toEqual({
      ok: true,
      payload: { repo: "auto", drill_type: "name", target: null, window: "window" },
    });
    expect(buildDrillRequest({ repo: "auto", drillType: "name", target: "N/A", window: "window" }).ok).toBe(false);
    expect(buildDrillRequest({ repo: "auto", drillType: "name", target: "has space", window: "window" }).ok).toBe(false);
  });

  test("validateSilenceDraft enforces Watchdog, alertname=, comment, UTC Z, future, and 4h/72h TTL", () => {
    const nowMs = Date.parse("2026-11-21T20:00:00Z");
    const validEnd4h = "2026-11-21T23:59:00Z";
    const over4h = "2026-11-22T01:00:00Z";
    const validEnd72h = "2026-11-24T19:00:00Z";
    const over72h = "2026-11-24T21:00:00Z";
    const alertMatchers = parseMatcherLines('alertname="HighErrorRate"\ncomponent=api');

    expect(hasWatchdogMatcher(parseMatcherLines('ALERTNAME="Watchdog"'))).toBe(true);
    expect(
      validateSilenceDraft({ matchers: parseMatcherLines("alertname=watchdog"), endsAt: validEnd4h, comment: "Valid comment text", maxHours: 72, nowMs }),
    ).toContain("unsilenceable");
    expect(
      validateSilenceDraft({ matchers: parseMatcherLines("component=api"), endsAt: validEnd4h, comment: "Valid comment text", maxHours: 72, nowMs }),
    ).toContain("alertname=");
    expect(
      validateSilenceDraft({ matchers: alertMatchers, endsAt: "2026-11-21T23:00:00+09:00", comment: "Valid comment text", maxHours: 72, nowMs }),
    ).toContain("RFC3339 UTC");
    expect(
      validateSilenceDraft({ matchers: alertMatchers, endsAt: "2026-11-21T19:00:00Z", comment: "Valid comment text", maxHours: 72, nowMs }),
    ).toContain("future");
    expect(
      validateSilenceDraft({ matchers: alertMatchers, endsAt: over4h, comment: "Valid comment text", maxHours: 4, nowMs }),
    ).toContain("4 hours");
    expect(
      validateSilenceDraft({ matchers: alertMatchers, endsAt: over72h, comment: "Valid comment text", maxHours: 72, nowMs }),
    ).toContain("72 hours");
    expect(
      validateSilenceDraft({ matchers: alertMatchers, endsAt: validEnd4h, comment: "Valid comment text", maxHours: 4, nowMs }),
    ).toBeNull();
    expect(
      validateSilenceDraft({ matchers: alertMatchers, endsAt: validEnd72h, comment: "Valid comment text", maxHours: 72, nowMs }),
    ).toBeNull();
  });

  test("SilencesTab disables submit and shows Watchdog DisabledReason for Watchdog matchers", async () => {
    const qc = new QueryClient();
    qc.setQueryData(opsQueryKeys.silences, {
      evaluated_at: TS,
      silences: [],
      count: { state: "Verified", value: 0, unit: null, source: "alertmanager", observed_at: TS, age_s: 1 },
    });
    const root = createRootRoute({
      component: () => createElement(SilencesTab, { initialMatchers: ['alertname="Watchdog"'], openCreate: true }),
    });
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: "/alerts", component: () => null }),
        createRoute({ getParentRoute: () => root, path: "/alerts/silences", component: () => null }),
        createRoute({ getParentRoute: () => root, path: "/oncall", component: () => null }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/alerts/silences"] }),
    });
    await router.load();

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          OpsContext.Provider,
          {
            value: {
              me: ME_SILENCE,
              live: { status: "Live", paused: false, pendingCount: 0, lastEventAt: null, disconnectedSince: null, disconnectedAgeS: 0 },
              reportEvaluatedAt: () => {},
            },
          },
          createElement(RouterProvider, { router }),
        ),
      ),
    );
    expect(html).toContain("Watchdog alert is unsilenceable by policy");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});
