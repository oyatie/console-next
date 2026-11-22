// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api/ops-schema";

type S = components["schemas"];
type Obs<T> = S["Observation"] & { value: T | null };

const TS = "2026-11-21T21:40:00Z";
const SINCE = "2026-11-21T21:15:00Z";

function ok<T>(value: T, source = "victoriametrics", unit: string | null = null): Obs<T> {
  return { state: "Verified", value, unit, source, observed_at: TS, age_s: 12, reason: null };
}

function mon<T>(value: T, source = "evaluator", unit: string | null = null): Obs<T> {
  return { state: "Monitoring", value, unit, source, observed_at: TS, age_s: 18, reason: null };
}

function stale<T>(value: T, reason: string, source = "bundle", unit: string | null = null): Obs<T> {
  return { state: "Stale", value, unit, source, observed_at: "2026-11-21T21:25:00Z", age_s: 900, reason };
}

function unk<T>(reason: string, source = "alertmanager"): Obs<T> {
  return { state: "Unknown", value: null, unit: null, source, observed_at: null, age_s: 0, reason };
}

type ScenarioName = "paging" | "quiet" | "source-down" | "stale" | "storm-146";

const ALL_ACTIONS = ["read.me", "read.home", "read.alerts", "read.running", "read.sources"];

export function makeMe(allowedActions: string[] = ALL_ACTIONS): S["Me"] {
  return {
    evaluated_at: TS,
    operator: {
      person: "11111111-1111-4111-8111-111111111111",
      display_email: "oncall@cosskorea.invalid",
    },
    grants: [
      { action: "read.home", from: "2026-11-21T00:00:00Z", until: "2026-11-22T00:00:00Z" },
    ],
    allowed_actions: allowedActions,
  };
}

function makeAlertDetail(key: string): S["AlertGroupDetail"] {
  const [alertname = "HighErrorRate", component = "api"] = key.split("×");
  return {
    key,
    alertname,
    component: ok(component, "alertmanager"),
    severity: ok("Page", "alertmanager"),
    state: ok("Firing", "alertmanager"),
    since: ok(SINCE, "alertmanager"),
    members_n: ok(2, "alertmanager"),
    summary: ok(`${alertname} on ${component} exceeded error budget threshold.`, "vmalert"),
    value_vs_threshold: {
      value: ok(3.8, "victoriametrics", "%"),
      threshold: ok(1.0, "vmalert", "%"),
      operator: ok(">", "vmalert"),
    },
    lead: ok("oncall@cosskorea.invalid", "evaluator"),
    impact: unk("not instrumented", "vmalert"),
    probable_cause: ok("Recent canary weight shift increased upstream 502 responses.", "evaluator"),
    first_action: ok("Verify api-canary error rate and hold traffic promotion.", "vmalert"),
    notices: [ok("Notice 2 · repeat interval 12h", "evaluator")],
    rule: {
      expression: ok(`sum(rate(http_requests_5xx_total{component="${component}"}[5m])) > 0.01`, "vmalert"),
      current_value: ok(0.038, "victoriametrics"),
    },
    members: [
      {
        fingerprint: "9f3c12aa81e04b12",
        labels: { component, host: "console-1", instance: "api-1:8080" },
        state: ok("Firing", "alertmanager"),
        since: ok(SINCE, "alertmanager"),
      },
      {
        fingerprint: "2a7b44cd19f0218c",
        labels: { component, host: "onprem-1", instance: "api-2:8080" },
        state: ok("Firing", "alertmanager"),
        since: ok(SINCE, "alertmanager"),
      },
    ],
    changes: [
      {
        at: ok("2026-11-21T21:10:00Z", "bundle"),
        summary: ok("Bundle sha 8f2a10c shifted canary weight to 25%", "bundle"),
      },
    ],
    links: [
      ok("https://github.com/oyatie/console-infra/blob/main/docs/runbooks/api-5xx.md#triage", "bundle"),
      ok("https://ops.cosskorea.com/d/api-latency?from=now-2h&to=now", "bundle"),
    ],
    footer_key: `group 9f3c12aa · host console-1 · ${TS}`,
  };
}

export function buildFixtures(scenario: ScenarioName) {
  const isQuiet = scenario === "quiet";
  const isSourceDown = scenario === "source-down";
  const isStale = scenario === "stale";
  const isStorm = scenario === "storm-146";

  const alertGroupsList: S["AlertGroup"][] = isQuiet
    ? []
    : isStorm
      ? Array.from({ length: 146 }, (_, i) => {
          const idx = String(i + 1).padStart(3, "0");
          const key = `StormAlert${idx}×worker-${(i % 6) + 1}`;
          return {
            key,
            alertname: `StormAlert${idx}`,
            component: ok(`worker-${(i % 6) + 1}`, "alertmanager"),
            severity: ok(i < 4 ? "Page" : "Ticket", "alertmanager"),
            state: ok(i % 5 === 0 ? "Inhibited" : "Firing", "alertmanager"),
            since: ok(SINCE, "alertmanager"),
            members_n: ok((i % 4) + 1, "alertmanager"),
            summary: ok(`Synthetic storm group ${idx} active.`, "vmalert"),
            value_vs_threshold: { value: ok(i + 1, "victoriametrics"), threshold: ok(0, "vmalert"), operator: ok(">", "vmalert") },
          };
        })
      : [
          makeAlertDetail("HighErrorRate×api"),
          {
            key: "BackupLagHigh×postgres",
            alertname: "BackupLagHigh",
            component: ok("postgres", "alertmanager"),
            severity: ok("Ticket", "alertmanager"),
            state: ok("Firing", "alertmanager"),
            since: ok("2026-11-21T20:30:00Z", "alertmanager"),
            members_n: ok(1, "alertmanager"),
            summary: ok("WAL archive lag exceeded 300s target.", "vmalert"),
            value_vs_threshold: { value: ok(420, "victoriametrics", "s"), threshold: ok(300, "vmalert", "s"), operator: ok(">", "vmalert") },
          },
          {
            key: "CertExpiringSoon×edge",
            alertname: "CertExpiringSoon",
            component: ok("edge", "alertmanager"),
            severity: ok("Ticket", "alertmanager"),
            state: ok("Acked", "alertmanager"),
            since: ok("2026-11-21T18:00:00Z", "alertmanager"),
            members_n: ok(1, "alertmanager"),
            summary: ok("Edge TLS certificate renews in 9d.", "vmalert"),
            value_vs_threshold: { value: ok(9, "victoriametrics", "d"), threshold: ok(14, "vmalert", "d"), operator: ok("<", "vmalert") },
          },
        ];

  const home: S["HomeSnapshot"] = {
    evaluated_at: TS,
    verdict: isQuiet
      ? { text: "All quiet · 0 pages · evidence fresh", worst: "Healthy" }
      : isSourceDown
        ? { text: "Alertmanager unreachable · 1 source down", worst: "Unknown" }
        : isStale
          ? { text: "2 stale sources · bundle age 15m", worst: "Degraded" }
          : { text: "1 page · HighErrorRate×api · 2 budgets burning", worst: "Degraded" },
    worklist: isQuiet
      ? []
      : [
          {
            kind: "page",
            title: ok("HighErrorRate on api (3.8% 5xx)", "vmalert"),
            component: ok("api", "alertmanager"),
            state: isStale ? stale("Degraded", "stale 15m") : ok("Degraded", "evaluator"),
            since: ok(SINCE, "alertmanager"),
            age: ok(1500, "evaluator", "s"),
            lead: ok("oncall@cosskorea.invalid", "evaluator"),
            next: { href: `/alerts/${encodeURIComponent("HighErrorRate×api")}`, label: "Inspect" },
          },
          {
            kind: "overdue",
            title: ok("Backup archive verify overdue", "textfile"),
            component: ok("backups", "textfile"),
            state: ok("Degraded", "textfile"),
            since: ok("2026-11-21T19:00:00Z", "textfile"),
            age: ok(9600, "evaluator", "s"),
            next: { href: "/running", label: "Check jobs" },
          },
          {
            kind: "due",
            title: ok("Canary bake watch expires 22:00Z", "bundle"),
            component: ok("edge", "bundle"),
            state: mon("Progressing", "bundle"),
            since: ok("2026-11-21T21:10:00Z", "bundle"),
            age: ok(1800, "evaluator", "s"),
            next: { href: "/running", label: "Review" },
          },
          {
            kind: "ticket",
            title: ok("CertExpiringSoon on edge", "alertmanager"),
            component: ok("edge", "alertmanager"),
            state: ok("Healthy", "evaluator"),
            since: ok("2026-11-21T18:00:00Z", "alertmanager"),
            age: ok(13200, "evaluator", "s"),
            next: { href: `/alerts/${encodeURIComponent("CertExpiringSoon×edge")}`, label: "Open" },
          },
        ],
    changing: isQuiet
      ? []
      : [
          {
            key: "console-api",
            digest: ok("sha256:8f2a10c9d1", "bundle"),
            colour: ok("green", "bundle"),
            canary_step: ok("step 2 / 4", "bundle"),
            bundle_sha: ok("8f2a10c", "bundle"),
            preview_candidate: ok("9a4c21e", "bundle"),
            maintenance_window: ok("none", "bundle"),
            weight_percent: ok(25, "bundle", "%"),
            watch_until: ok("2026-11-21T22:00:00Z", "bundle"),
            freeze: ok(false, "bundle"),
            next: { href: "/running", label: "Running" },
          },
        ],
    budgets: [
      {
        key: "api-availability",
        remaining_percent: ok(64.5, "victoriametrics", "%"),
        burn_1h: ok(2.4, "victoriametrics", "x"),
        burn_6h: ok(1.1, "victoriametrics", "x"),
        exhaustion_s: ok(28800, "victoriametrics", "s"),
        requests_30d: ok(4250000, "victoriametrics"),
      },
      {
        key: "auth-slo",
        remaining_percent: ok(0, "victoriametrics", "%"),
        burn_1h: ok(0, "victoriametrics", "x"),
        burn_6h: ok(0, "victoriametrics", "x"),
        exhaustion_s: ok(0, "victoriametrics", "s"),
        requests_30d: ok(910000, "victoriametrics"),
      },
    ],
    data_safety: [
      {
        repository: "pgbackrest-main",
        rpo_s: ok(45, "textfile", "s"),
        limit_s: ok(300, "textfile", "s"),
        last_base_backup: ok("2026-11-21T02:00:00Z", "textfile"),
        last_proven_restore: ok("2026-11-20T04:15:00Z", "textfile"),
      },
    ],
    cost: [
      {
        key: "oci-ap-seoul-1",
        mtd: isStale ? stale(184.2, "stale 2h 10m", "textfile", "USD") : ok(184.2, "textfile", "USD"),
        lag_s: ok(900, "textfile", "s"),
        billed_skus: ok(14, "textfile"),
        limits: [
          {
            key: "Object Storage Free Tier",
            used: ok(14, "textfile"),
            limit: ok(20, "textfile"),
            warning_ratio: ok(0.8, "evaluator"),
          },
        ],
      },
    ],
    evidence: {
      counts: isSourceDown
        ? { Verified: 4, Monitoring: 1, Stale: 0, Unknown: 1 }
        : isStale
          ? { Verified: 3, Monitoring: 1, Stale: 2, Unknown: 0 }
          : { Verified: 5, Monitoring: 1, Stale: 0, Unknown: 0 },
      sources: isSourceDown
        ? [
            {
              name: "alertmanager-primary",
              kind: "alertmanager",
              producer: "alertmanager",
              interval: 30,
              observed_at: null,
              age: 0,
              state: "Unknown",
              reason: "source down",
            },
          ]
        : isStale
          ? [
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
            ]
          : [],
    },
  };

  const alerts: S["AlertGroups"] = {
    evaluated_at: TS,
    groups: alertGroupsList,
    count: isSourceDown ? unk("source down") : ok(alertGroupsList.length, "alertmanager"),
    alert_count: isSourceDown
      ? unk("source down")
      : ok(alertGroupsList.reduce((acc, g) => acc + (typeof g.members_n.value === "number" ? g.members_n.value : 0), 0), "alertmanager"),
  };

  const silences: S["Silences"] = {
    evaluated_at: TS,
    silences: [],
    count: ok(0, "alertmanager"),
  };

  const running: S["Running"] = {
    evaluated_at: TS,
    hosts: [
      { key: "console-1", health: isStale ? unk("stale 15m", "bundle") : ok("Healthy", "bundle"), drift: isStale ? stale("Synced", "stale 15m") : ok("Synced", "bundle") },
      { key: "onprem-1", health: ok("Degraded", "bundle"), drift: ok("OutOfSync", "bundle") },
    ],
    groups: [
      { key: "core", health: ok("Degraded", "bundle"), drift: ok("Synced", "bundle") },
      { key: "edge", health: ok("Healthy", "bundle"), drift: ok("Synced", "bundle") },
    ],
    components: [
      {
        key: "console-api",
        group: "core",
        host: "console-1",
        health: isStale ? stale("Degraded", "stale 15m") : ok("Degraded", "bundle"),
        drift: ok("Synced", "bundle"),
        membership: "Declared",
        source: "bundle",
        observed_at: TS,
        age: 14,
        runbook: ok("https://github.com/oyatie/console-infra/blob/main/docs/runbooks/api.md", "bundle"),
      },
      {
        key: "debug-sidecar",
        group: "edge",
        host: "onprem-1",
        health: ok("Healthy", "bundle"),
        drift: ok("OutOfSync", "bundle"),
        membership: "Extra",
        source: "bundle",
        observed_at: TS,
        age: 22,
        runbook: unk("not instrumented", "bundle"),
      },
    ],
    count: ok(2, "bundle"),
  };

  const jobs: S["Jobs"] = {
    evaluated_at: TS,
    jobs: [
      {
        name: "pgbackrest-incr",
        state: ok("Succeeded", "textfile"),
        last_run: ok("2026-11-21T21:00:00Z", "textfile"),
        last_exit: ok(0, "textfile"),
        budget: ok(900, "textfile", "s"),
        next_run: ok("2026-11-21T22:00:00Z", "textfile"),
      },
      {
        name: "billing-export",
        state: ok("Late", "textfile"),
        last_run: ok("2026-11-21T18:00:00Z", "textfile"),
        last_exit: ok(1, "textfile"),
        budget: ok(7200, "textfile", "s"),
      },
    ],
    count: ok(2, "textfile"),
  };

  const sources: S["Sources"] = {
    evaluated_at: TS,
    sources: [
      {
        name: "victoriametrics",
        kind: "victoriametrics",
        producer: "vmselect",
        interval: 30,
        observed_at: TS,
        age: 12,
        state: "Verified",
        reason: null,
      },
      isSourceDown
        ? {
            name: "alertmanager-primary",
            kind: "alertmanager",
            producer: "alertmanager",
            interval: 30,
            observed_at: null,
            age: 0,
            state: "Unknown",
            reason: "source down",
          }
        : {
            name: "alertmanager-primary",
            kind: "alertmanager",
            producer: "alertmanager",
            interval: 30,
            observed_at: TS,
            age: 14,
            state: "Verified",
            reason: null,
          },
      isStale
        ? {
            name: "config-bundle",
            kind: "bundle",
            producer: "deploy-bundle",
            interval: 60,
            observed_at: "2026-11-21T21:25:00Z",
            age: 900,
            state: "Stale",
            reason: "stale 15m",
          }
        : {
            name: "config-bundle",
            kind: "bundle",
            producer: "deploy-bundle",
            interval: 60,
            observed_at: TS,
            age: 18,
            state: "Monitoring",
            reason: null,
          },
    ],
  };

  return { me: makeMe(), home, alerts, silences, running, jobs, sources };
}

export async function mountOpsMock(
  page: Page,
  scenario: ScenarioName,
  overrides: {
    meStatus?: number;
    meError?: S["Error"];
    meOverride?: S["Me"];
    sseStatus?: number;
    sseBody?: string;
    extraAlertKeys?: string[];
    onAlertsRequest?: (url: URL) => void;
    onHomeRequest?: () => void;
  } = {},
) {
  const data = buildFixtures(scenario);
  if (overrides.extraAlertKeys?.length) {
    const extras = overrides.extraAlertKeys.map((k) => makeAlertDetail(k));
    data.alerts = {
      ...data.alerts,
      groups: [...extras, ...data.alerts.groups],
    };
  }
  const unexpected: string[] = [];
  const lastEventIds: (string | undefined)[] = [];
  const alertDetailPaths: string[] = [];

  await page.addInitScript(
    (cfg: { sseStatus: number }) => {
      const w = window as unknown as {
        __opsSseInstalled?: boolean;
        __opsSseConfig?: { sseStatus: number };
        __opsSseLastEventIds?: (string | null)[];
        __opsSseConnectCount?: number;
        __pushSse?: (event: string, id: number, data: unknown) => void;
        __dropSse?: () => void;
      };
      w.__opsSseConfig = cfg;
      w.__opsSseLastEventIds = [];
      w.__opsSseConnectCount = 0;
      if (w.__opsSseInstalled) return;
      w.__opsSseInstalled = true;
      const origFetch = window.fetch.bind(window);
      const enc = new TextEncoder();
      let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
      w.__pushSse = (event, id, payload) => {
        if (!ctrl) return;
        ctrl.enqueue(enc.encode(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      w.__dropSse = () => {
        if (!ctrl) return;
        ctrl.error(new Error("stream dropped"));
        ctrl = null;
      };
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (url.includes("/api/ops/v1/events")) {
          w.__opsSseConnectCount = (w.__opsSseConnectCount ?? 0) + 1;
          const headers = init?.headers;
          let lastId: string | null = null;
          if (headers instanceof Headers) {
            lastId = headers.get("last-event-id");
          } else if (headers && typeof headers === "object" && !Array.isArray(headers)) {
            const rec = headers as Record<string, string>;
            lastId = rec["last-event-id"] ?? rec["Last-Event-ID"] ?? null;
          }
          w.__opsSseLastEventIds?.push(lastId);
          const status = w.__opsSseConfig?.sseStatus ?? 200;
          if (status !== 200) {
            return Promise.resolve(new Response("", { status, headers: { "content-type": "application/json" } }));
          }
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              ctrl = c;
              c.enqueue(enc.encode(`event: heartbeat\nid: 1\ndata: ${JSON.stringify({ type: "heartbeat", id: 1, evaluated_at: "2026-11-21T21:40:00Z" })}\n\n`));
            },
          });
          return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        return origFetch(input, init);
      };
    },
    { sseStatus: overrides.sseStatus ?? 200 },
  );

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;

    if (path === "/api/ops/v1/me") {
      if (overrides.meStatus && overrides.meStatus >= 400) {
        return route.fulfill({
          status: overrides.meStatus,
          contentType: "application/json",
          body: JSON.stringify(
            overrides.meError ?? {
              evaluated_at: TS,
              support_ref: `sup-${overrides.meStatus}`,
              code: overrides.meStatus === 401 ? "OPS_ACCESS_JWT_MISSING" : overrides.meStatus === 403 ? "OPS_NOT_OPERATOR" : "OPS_TIMEOUT",
              message: "Simulated ops refusal",
            },
          ),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.meOverride ?? data.me),
      });
    }

    if (path === "/api/ops/v1/home") {
      overrides.onHomeRequest?.();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.home) });
    }

    if (path === "/api/ops/v1/alerts") {
      overrides.onAlertsRequest?.(url);
      const state = url.searchParams.get("state");
      const severity = url.searchParams.get("severity");
      const component = url.searchParams.get("component");
      const filtered = data.alerts.groups.filter((g) => {
        if (state && g.state.value !== state) return false;
        if (severity && g.severity.value !== severity) return false;
        if (component && !String(g.component.value ?? "").toLowerCase().includes(component.toLowerCase())) return false;
        return true;
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...data.alerts, groups: filtered }),
      });
    }

    if (path.startsWith("/api/ops/v1/alerts/")) {
      alertDetailPaths.push(path);
      const encoded = path.slice("/api/ops/v1/alerts/".length);
      const decoded = decodeURIComponent(encoded);
      const detail: S["AlertDetail"] = {
        evaluated_at: TS,
        group: makeAlertDetail(decoded),
      };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail) });
    }

    if (path === "/api/ops/v1/silences") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.silences) });
    }

    if (path === "/api/ops/v1/running") {
      const group = url.searchParams.get("group");
      const state = url.searchParams.get("state");
      const filtered = data.running.components.filter((c) => {
        if (group && !c.group.toLowerCase().includes(group.toLowerCase())) return false;
        if (state && c.health.value !== state) return false;
        return true;
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...data.running, components: filtered }),
      });
    }

    if (path === "/api/ops/v1/running/jobs") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.jobs) });
    }

    if (path === "/api/ops/v1/sources") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.sources) });
    }

    if (path === "/api/ops/v1/events") {
      lastEventIds.push(req.headers()["last-event-id"]);
      const body =
        overrides.sseBody ??
        `event: heartbeat\nid: 1\ndata: ${JSON.stringify({ type: "heartbeat", id: 1, evaluated_at: TS })}\n\n`;
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-store" },
        body,
      });
    }

    unexpected.push(`${req.method()} ${path}`);
    return route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "unmocked" }) });
  });

  return {
    data,
    unexpected,
    lastEventIds,
    alertDetailPaths,
    getLastEventIds: () =>
      page.evaluate(() => (window as unknown as { __opsSseLastEventIds?: (string | null)[] }).__opsSseLastEventIds ?? []),
    getSseConnectCount: () =>
      page.evaluate(() => (window as unknown as { __opsSseConnectCount?: number }).__opsSseConnectCount ?? 0),
  };
}
