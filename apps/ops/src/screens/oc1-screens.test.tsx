// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { opsQueryKeys, type OpsMe } from "../lib/api";
import { OpsContext } from "../lib/ops-context";
import { ChangesControls } from "./changes-controls";
import { ChangesScreen } from "./changes-screen";
import { HealthScreen } from "./health-screen";
import { ObligationsScreen } from "./obligations-screen";
import { OncallScreen } from "./oncall-screen";
import { PromoteScreen } from "./promote-screen";
import { RecoveryScreen } from "./recovery-screen";

const TS = "2026-11-21T21:40:00Z";
const ok = <T,>(value: T) => ({ state: "Verified" as const, value, unit: null, source: "test", observed_at: TS, age_s: 5 });

const ME_FULL: OpsMe = {
  evaluated_at: TS,
  operator: { person: "11111111-1111-4111-8111-111111111111", display_email: "oncall@cosskorea.invalid" },
  grants: [],
  allowed_actions: ["read.me", "read.home", "read.alerts", "read.running", "obligation.read", "recovery.read"],
};

const ME_MINIMAL: OpsMe = {
  ...ME_FULL,
  allowed_actions: ["read.me"],
};

async function renderScreen(qc: QueryClient, me: OpsMe, path: string, node: ReactNode) {
  const root = createRootRoute({ component: () => node });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/health", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/alerts", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/alerts/silences", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/oncall", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/running", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/running/jobs", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/changes", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/promote", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/actions", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/runbooks", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/obligations", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/recovery", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        OpsContext.Provider,
        {
          value: {
            me,
            live: { status: "Live", paused: false, pendingCount: 0, lastEventAt: null, disconnectedSince: null, disconnectedAgeS: 0 },
            reportEvaluatedAt: () => {},
          },
        },
        createElement(RouterProvider, { router }),
      ),
    ),
  );
}

describe("OC1 screen invariants and Cedar refusals", () => {
  test("HealthScreen keeps internal SLOs and public status feed unblended", async () => {
    const qc = new QueryClient();
    qc.setQueryData(opsQueryKeys.health, {
      evaluated_at: TS,
      internal_slos: [
        {
          key: "api-availability",
          remaining_percent: ok(82.4),
          burn_30m: ok(0.5),
          burn_1h: ok(0.8),
          burn_6h: ok(1.0),
          burn_3d: ok(0.9),
          burn_30d: ok(0.7),
          exhaustion_s: ok(86400),
          requests_30d: ok(12000),
          low_sample: true,
          low_sample_note: "Below 50k monthly baseline",
        },
      ],
      page_load_error_rate_5m: ok(0.01),
      page_loads_rate_5m: ok(12.5),
      evidence_truth: [{ source: "victoriametrics", ok: ok(true) }],
      textfiles: [{ file: "backups.prom", age_s: ok(15), max_age_s: ok(120) }],
      public_status: {
        feed_ok: ok(true),
        revision: ok(42),
        published_at: ok(TS),
        observed_at: ok(TS),
        expires_at: ok("2026-11-22T21:40:00Z"),
        unknown_components: ok(0),
        components: { web: ok("Operational") },
      },
    });
    const html = await renderScreen(qc, ME_FULL, "/health", createElement(HealthScreen));
    expect(html).toContain("Internal SLOs");
    expect(html).toContain("Public status feed (unblended)");
    expect(html).toContain("Below 50k monthly baseline");
    expect(html).toContain("Operational");
  });

  test("OncallScreen, ObligationsScreen, ChangesScreen, PromoteScreen, and RecoveryScreen render domain truth and Cedar refusals", async () => {
    const qc = new QueryClient();
    qc.setQueryData(opsQueryKeys.oncall, {
      evaluated_at: TS,
      config: {
        version: 1,
        mode: "single-operator",
        display_status: "Single operator on call",
        timezone: "Asia/Seoul",
        rotation: { primary_person: "11111111-1111-4111-8111-111111111111", backup_person: null, handoff_weekday: "Mon", handoff_hour_local: 9 },
        escalation: { ack_timeout_s: 300, repeat_interval_s: 900, out_of_hours_policy: "sev1-symptoms-only", daily_page_budget: 2 },
        synthetic_page_test: { enabled: true, schedule: "weekly", weekday: "Wed", hour_utc: 2, max_delivery_lag_s: 120 },
      },
      display_status: ok("Single operator on call"),
      last_page_test_at: ok(TS),
      last_page_test_ok: ok(true),
    });
    const oncallHtml = await renderScreen(qc, ME_FULL, "/oncall", createElement(OncallScreen));
    expect(oncallHtml).toContain("Single operator on call");
    expect(oncallHtml).toContain("Requires jobs.rerun grant");

    qc.setQueryData(opsQueryKeys.obligations({}), {
      evaluated_at: TS,
      verdict: { text: "Blocked: 1 open launch gate", worst: "Degraded" },
      launch_readiness: { text: "Blocked: 1 open launch gate", worst: "Degraded" },
      items: [{ id: "OBL-1", kind: "launch-gate", reviewer_role: "owner", title: "Signoff launch gate", due: "2026-11-25", state: "open", evidence_ref: null, signer: null, signed_on: null, deadline: "D-4" }],
      count: ok(1),
      sources: [{ name: "obligations", kind: "obligations", producer: "spool", interval: 60, observed_at: TS, age: 5, state: "Verified", reason: null }],
    });
    const oblHtml = await renderScreen(qc, ME_FULL, "/obligations", createElement(ObligationsScreen, { filters: {}, onFiltersChange: () => {} }));
    expect(oblHtml).toContain("Blocked: 1 open launch gate");
    expect(oblHtml).toContain("Signoff launch gate");

    qc.setQueryData(opsQueryKeys.changes, {
      evaluated_at: TS,
      releases: [{ digest: `sha256:${"a".repeat(64)}`, state: "Unknown", reason: "gate missing" }],
      timeline: [],
      dora5: { deployment_frequency: ok(1.2), lead_time_s: ok(1800), change_failure_rate: ok(0), mttr_s: ok(600), rework_rate: ok(0), n: 3 },
      freeze: ok(false),
      canary_percent: ok(25),
      bundle_sha: ok("8f2a10c"),
    });
    const chgHtml = await renderScreen(qc, ME_FULL, "/changes", createElement(ChangesScreen));
    expect(chgHtml).toContain("Unknown: gate missing");
    expect(chgHtml).toContain("0.0%");
    expect(chgHtml).not.toContain("Exhausted");

    qc.setQueryData(opsQueryKeys.promote, {
      evaluated_at: TS,
      candidate_digest: ok(`sha256:${"b".repeat(64)}`),
      state: ok("Blocked"),
      signoffs: [],
      feedback: [],
    });
    const promHtml = await renderScreen(qc, ME_FULL, "/promote", createElement(PromoteScreen));
    expect(promHtml).toContain("Blocked");

    qc.setQueryData(opsQueryKeys.recovery, {
      evaluated_at: TS,
      repos: [{ repository: "repo-2", rpo_s: ok(40), limit_s: ok(300), last_base_backup: ok(TS), push_failures: ok(0) }],
      rto: { state: "Unknown", value: null, unit: null, source: "dr-rehearse", observed_at: null, age_s: 0, reason: "Not measured" },
      deferred_since: { state: "Unknown", value: null, unit: null, source: "recovery", observed_at: null, age_s: 0, reason: "none" },
      last_exit_code: ok(0),
      lvm_snapshot_at: ok(TS),
      onprem_mount_expected: ok(true),
    });
    const recHtml = await renderScreen(qc, ME_FULL, "/recovery", createElement(RecoveryScreen));
    expect(recHtml).toContain("Unknown: Not measured");

    const refusedHtml = await renderScreen(qc, ME_MINIMAL, "/obligations", createElement(ObligationsScreen, { filters: {}, onFiltersChange: () => {} }));
    expect(refusedHtml).toContain("Permission missing");
    expect(refusedHtml).toContain("ops-action-denied");
  });

  test("malformed Record<string, never> payloads degrade safely and ChangesControls surfaces partial grants", async () => {
    const qc = new QueryClient();
    qc.setQueryData(opsQueryKeys.oncall, {
      evaluated_at: TS,
      config: { rotation: {}, escalation: {}, synthetic_page_test: {} },
      display_status: ok("Single operator on call"),
      last_page_test_at: ok(TS),
      last_page_test_ok: ok(true),
    });
    const badOncallHtml = await renderScreen(qc, ME_FULL, "/oncall", createElement(OncallScreen));
    expect(badOncallHtml).toContain("On-call configuration unavailable");

    qc.setQueryData(opsQueryKeys.changes, {
      evaluated_at: TS,
      releases: [{ digest: `sha256:${"c".repeat(64)}`, state: "Verified", gates: { predicate: { gates: [null] } } }],
      timeline: [],
      dora5: { deployment_frequency: ok(1.0), lead_time_s: ok(100), change_failure_rate: ok(0), mttr_s: ok(50), rework_rate: ok(0), n: 1 },
      freeze: ok(false),
      canary_percent: ok(0),
      bundle_sha: ok("abc"),
    });
    const badGateHtml = await renderScreen(qc, ME_FULL, "/changes", createElement(ChangesScreen));
    expect(badGateHtml).toContain("Unknown: gate missing");

    qc.setQueryData(opsQueryKeys.changes, {
      evaluated_at: TS,
      releases: [],
      timeline: [],
      dora5: {
        deployment_frequency: ok(Number.NaN),
        lead_time_s: ok(100),
        change_failure_rate: ok(0),
        mttr_s: ok(50),
        rework_rate: ok(0),
        n: 1,
      },
      freeze: ok(false),
      canary_percent: ok(Number.NaN),
      bundle_sha: ok("abc"),
    });
    const nanChangesHtml = await renderScreen(qc, ME_FULL, "/changes", createElement(ChangesScreen));
    expect(nanChangesHtml).not.toContain("NaN%");
    expect(nanChangesHtml).not.toContain("NaN");
    expect(nanChangesHtml).toContain("Unknown: not instrumented");

    const partialMe: OpsMe = { ...ME_FULL, allowed_actions: [...ME_FULL.allowed_actions, "change.request.freeze"] };
    const partialHtml = await renderScreen(qc, partialMe, "/changes", createElement(ChangesControls, { isFrozen: false, defaultDigest: "sha256:abc" }));
    expect(partialHtml).toContain("Requires change.request.canary-hold");
    expect(partialHtml).toContain("change.request.rollback");
    expect(partialHtml).not.toContain("change.request.freeze");
  });
});
