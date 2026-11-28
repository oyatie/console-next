// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api/ops-schema";
import { ALL_OC1_ACTIONS, buildOc1Fixtures } from "./oc1-fixtures";

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

export function makeMe(allowedActions: string[] = ALL_OC1_ACTIONS): S["Me"] {
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
    severity: ok(alertname.toLowerCase() === "watchdog" ? "Ticket" : "Page", "alertmanager"),
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
    ...(isQuiet ? {} : { launch_readiness: { text: "Blocked: 2 open launch gates", worst: "Degraded" as const } }),
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
            next: { href: "/running/jobs", label: "Check jobs" },
          },
          {
            kind: "due",
            title: ok("Canary bake watch expires 22:00Z", "bundle"),
            component: ok("edge", "bundle"),
            state: mon("Progressing", "bundle"),
            since: ok("2026-11-21T21:10:00Z", "bundle"),
            age: ok(1800, "evaluator", "s"),
            next: { href: "/changes", label: "Review" },
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
        ? [{ name: "alertmanager-primary", kind: "alertmanager", producer: "alertmanager", interval: 30, observed_at: null, age: 0, state: "Unknown", reason: "source down" }]
        : isStale
          ? [{ name: "config-bundle", kind: "bundle", producer: "deploy-bundle", interval: 60, observed_at: "2026-11-21T21:25:00Z", age: 900, state: "Stale", reason: "stale 15m" }]
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
      { name: "victoriametrics", kind: "victoriametrics", producer: "vmselect", interval: 30, observed_at: TS, age: 12, state: "Verified", reason: null },
      isSourceDown
        ? { name: "alertmanager-primary", kind: "alertmanager", producer: "alertmanager", interval: 30, observed_at: null, age: 0, state: "Unknown", reason: "source down" }
        : { name: "alertmanager-primary", kind: "alertmanager", producer: "alertmanager", interval: 30, observed_at: TS, age: 14, state: "Verified", reason: null },
      isStale
        ? { name: "config-bundle", kind: "bundle", producer: "deploy-bundle", interval: 60, observed_at: "2026-11-21T21:25:00Z", age: 900, state: "Stale", reason: "stale 15m" }
        : { name: "config-bundle", kind: "bundle", producer: "deploy-bundle", interval: 60, observed_at: TS, age: 18, state: "Monitoring", reason: null },
    ],
  };

  return { me: makeMe(), home, alerts, silences, running, jobs, sources, oc1: buildOc1Fixtures() };
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
    brokenObligationChain?: boolean;
    forceConflictOnce?: boolean;
    onAlertsRequest?: (url: URL) => void;
    onHomeRequest?: () => void;
    onDrillBody?: (body: Record<string, unknown>) => void;
  } = {},
) {
  const data = buildFixtures(scenario);
  if (overrides.extraAlertKeys?.length) {
    const extras = overrides.extraAlertKeys.map((k) => makeAlertDetail(k));
    data.alerts = { ...data.alerts, groups: [...extras, ...data.alerts.groups] };
  }
  const unexpected: string[] = [];
  const lastEventIds: (string | undefined)[] = [];
  const alertDetailPaths: string[] = [];
  const runbookPaths: string[] = [];
  let conflictPending = Boolean(overrides.forceConflictOnce);
  let nextActSeq = 2;

  const makeHandOff = (kind: string, command: string, target: string): S["CmdHandOff"] => {
    const actionId = `ACT-${String(nextActSeq).padStart(4, "0")}`;
    const rec: S["ActionRecord"] = {
      seq: nextActSeq++,
      hash: `act-hash-${nextActSeq}`,
      support_ref: `sup-act-${nextActSeq}`,
      status: "pending",
      action_id: actionId,
      kind,
      command,
      target,
      consequence: `Applies ${kind} on ${target}`,
      expected_result: `${kind} scheduled`,
      verify_step: "Inspect /actions",
      operator: "oncall@cosskorea.invalid",
      at: TS,
    };
    data.oc1.actions.unshift(rec);
    return rec;
  };

  await page.addInitScript(
    (cfg: { sseStatus: number }) => {
      const w = window as unknown as {
        __opsSseInstalled?: boolean;
        __opsSseConfig?: { sseStatus: number };
        __opsSseLastEventIds?: (string | null)[];
        __opsSseConnectCount?: number;
        __pushSse?: (event: string, id: number, data: unknown) => void;
        __dropSse?: () => void;
        __setSseStatus?: (status: number) => void;
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
      w.__setSseStatus = (status) => {
        if (w.__opsSseConfig) w.__opsSseConfig.sseStatus = status;
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
          if (headers instanceof Headers) lastId = headers.get("last-event-id");
          else if (headers && typeof headers === "object" && !Array.isArray(headers)) {
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
    const method = req.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/ops/v1/me") {
      if (overrides.meStatus && overrides.meStatus >= 400) {
        return json(overrides.meStatus, overrides.meError ?? {
          evaluated_at: TS,
          support_ref: `sup-${overrides.meStatus}`,
          code: overrides.meStatus === 401 ? "OPS_ACCESS_JWT_MISSING" : overrides.meStatus === 403 ? "OPS_NOT_OPERATOR" : "OPS_TIMEOUT",
          message: "Simulated ops refusal",
        });
      }
      return json(200, overrides.meOverride ?? data.me);
    }

    if (path === "/api/ops/v1/home") {
      overrides.onHomeRequest?.();
      return json(200, data.home);
    }

    if (path === "/api/ops/v1/health") return json(200, data.oc1.health);
    if (path === "/api/ops/v1/oncall") return json(200, data.oc1.oncall);
    if (path === "/api/ops/v1/oncall/page-test" && method === "POST") {
      return json(201, { evaluated_at: TS, action: makeHandOff("page-test", "sudo systemctl start console-oncall-test.service", "oncall") });
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
      return json(200, { ...data.alerts, groups: filtered });
    }

    if (path.startsWith("/api/ops/v1/alerts/") && path.endsWith("/ack") && method === "POST") {
      const encodedKey = path.slice("/api/ops/v1/alerts/".length, -"/ack".length);
      const key = decodeURIComponent(encodedKey);
      const body = req.postDataJSON() as S["AckRequest"];
      if (body.note && ["no data", "n/a", "—"].includes(body.note.trim().toLowerCase())) {
        return json(400, { evaluated_at: TS, support_ref: "sup-ack-400", code: "OPS_ALERT_ACK_INVALID", message: "Placeholder acknowledgement note rejected." });
      }
      const detail = makeAlertDetail(key);
      detail.state = ok("Acked", "alerts");
      return json(200, {
        evaluated_at: TS,
        record: { seq: 1, hash: "ack-h1", support_ref: "sup-ack-1", at: TS, operator: "oncall@cosskorea.invalid", group_key: key, alertname: detail.alertname, component: "api", note: body.note ?? null },
        group: detail,
      });
    }

    if (path.startsWith("/api/ops/v1/alerts/") && method === "GET") {
      alertDetailPaths.push(path);
      const decoded = decodeURIComponent(path.slice("/api/ops/v1/alerts/".length));
      return json(200, { evaluated_at: TS, group: makeAlertDetail(decoded) });
    }

    if (path === "/api/ops/v1/silences" && method === "GET") return json(200, data.silences);
    if (path === "/api/ops/v1/silences" && method === "POST") {
      const body = req.postDataJSON() as S["SilenceCreateRequest"];
      if (body.matchers.some((m) => m.name === "alertname" && m.value.toLowerCase() === "watchdog")) {
        return json(422, { evaluated_at: TS, support_ref: "sup-wd", code: "OPS_WATCHDOG_UNSILENCEABLE", message: "Watchdog cannot be silenced." });
      }
      const id = `sil-${data.silences.silences.length + 1}`;
      data.silences.silences.push({
        id,
        matchers: body.matchers.map((m) => ({ name: m.name, value: m.value, is_equal: m.is_equal ?? true, is_regex: m.is_regex ?? false })),
        starts: ok(TS, "alertmanager"),
        ends: ok(body.ends_at, "alertmanager"),
        author: ok("oncall@cosskorea.invalid", "alertmanager"),
        comment: ok(body.comment, "alertmanager"),
      });
      data.silences.count = ok(data.silences.silences.length, "alertmanager");
      return json(201, { evaluated_at: TS, silence_id: id });
    }
    if (path.startsWith("/api/ops/v1/silences/") && method === "DELETE") {
      const id = path.slice("/api/ops/v1/silences/".length);
      data.silences.silences = data.silences.silences.filter((s) => s.id !== id);
      data.silences.count = ok(data.silences.silences.length, "alertmanager");
      return json(200, { evaluated_at: TS, silence_id: id, deleted: true });
    }

    if (path === "/api/ops/v1/running") {
      const group = url.searchParams.get("group");
      const state = url.searchParams.get("state");
      const filtered = data.running.components.filter((c) => {
        if (group && !c.group.toLowerCase().includes(group.toLowerCase())) return false;
        if (state && c.health.value !== state) return false;
        return true;
      });
      return json(200, { ...data.running, components: filtered });
    }
    if (path === "/api/ops/v1/running/jobs") return json(200, data.jobs);
    if (path.startsWith("/api/ops/v1/running/jobs/") && path.endsWith("/rerun") && method === "POST") {
      const name = decodeURIComponent(path.slice("/api/ops/v1/running/jobs/".length, -"/rerun".length));
      return json(201, { evaluated_at: TS, action: makeHandOff("job-rerun", `sudo systemctl start console-${name}.service`, name) });
    }

    if (path === "/api/ops/v1/changes") return json(200, data.oc1.changes);
    if (path === "/api/ops/v1/changes/freeze" && method === "POST") {
      const body = req.postDataJSON() as S["FreezeRequest"];
      data.oc1.changes.freeze = ok(body.freeze, "bundle");
      return json(201, { evaluated_at: TS, action: makeHandOff(body.freeze ? "freeze" : "unfreeze", `scripts/tb ${body.freeze ? "freeze" : "unfreeze"}`, "production") });
    }
    if (path === "/api/ops/v1/changes/canary" && method === "POST") {
      const body = req.postDataJSON() as S["CanaryRequest"];
      return json(201, { evaluated_at: TS, action: makeHandOff(`canary-${body.decision}`, `scripts/tb canary-${body.decision}`, "console-api") });
    }
    if (path === "/api/ops/v1/changes/rollback" && method === "POST") {
      const body = req.postDataJSON() as S["RollbackRequest"];
      return json(201, { evaluated_at: TS, action: makeHandOff("rollback", `APPROVER=oncall scripts/tb rollback ${body.digest}`, body.digest) });
    }

    const recomputePromoteState = (): S["Promotion"] => {
      const frozen = data.oc1.changes.freeze.value === true;
      const openBlocker = data.oc1.promote.feedback.some(
        (f) => (f.severity === "P0" || f.severity === "P1") && f.disposition === "open",
      );
      const blockedSignoff = data.oc1.promote.signoffs.some((s) => s.verdict !== "ready");
      if (frozen || openBlocker || blockedSignoff) return "Blocked";
      return data.oc1.promote.signoffs.length ? "Ready" : "Watching";
    };

    if (path === "/api/ops/v1/promote") {
      data.oc1.promote.state = { state: "Verified", value: recomputePromoteState(), unit: null, source: "promote", observed_at: TS, age_s: 5, reason: null };
      return json(200, data.oc1.promote);
    }
    if (path === "/api/ops/v1/promote/feedback" && method === "POST") {
      const body = req.postDataJSON() as S["FeedbackRequest"];
      const entry: S["FeedbackTriage"] = { seq: 2, hash: "fb-h2", support_ref: "sup-fb-2", at: TS, operator: "oncall@cosskorea.invalid", ...body };
      data.oc1.promote.feedback = [entry];
      data.oc1.promote.state = { state: "Verified", value: recomputePromoteState(), unit: null, source: "promote", observed_at: TS, age_s: 5, reason: null };
      return json(201, { evaluated_at: TS, feedback: entry });
    }
    if (path === "/api/ops/v1/promote/signoff" && method === "POST") {
      const body = req.postDataJSON() as S["SignoffRequest"];
      const entry: S["PromotionSignoff"] = { seq: 1, hash: "sig-h1", support_ref: "sup-sig-1", at: TS, operator: "oncall@cosskorea.invalid", ...body };
      data.oc1.promote.signoffs.push(entry);
      data.oc1.promote.state = { state: "Verified", value: recomputePromoteState(), unit: null, source: "promote", observed_at: TS, age_s: 5, reason: null };
      return json(201, { evaluated_at: TS, signoff: entry });
    }
    if (path === "/api/ops/v1/promote/request" && method === "POST") {
      const body = req.postDataJSON() as S["PromoteRequest"];
      if (recomputePromoteState() !== "Ready" || body.digest !== data.oc1.promote.candidate_digest.value || body.bake !== data.oc1.promote.signed_bake) {
        return json(409, { evaluated_at: TS, support_ref: "sup-promo", code: "OPS_PROMOTE_NOT_READY", message: "candidate digest is not ready for promotion" });
      }
      return json(201, { evaluated_at: TS, action: makeHandOff("promote", `APPROVER='oncall' scripts/tb release ${data.oc1.promote.release_image}`, body.digest) });
    }

    if (path === "/api/ops/v1/actions") {
      return json(200, { evaluated_at: TS, actions: data.oc1.actions, count: ok(data.oc1.actions.length, "actions") });
    }

    if (path === "/api/ops/v1/recovery") return json(200, data.oc1.recovery);
    if (path === "/api/ops/v1/recovery/backup" && method === "POST") {
      const body = req.postDataJSON() as S["BackupRequest"];
      return json(201, { evaluated_at: TS, action: makeHandOff("backup-now", `scripts/tb backup-now type=${body.backup_type} window=${body.window}`, "pgbackrest") });
    }
    if (path === "/api/ops/v1/recovery/drill" && method === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      overrides.onDrillBody?.(body);
      if ("tenant" in body) return json(400, { evaluated_at: TS, support_ref: "sup-drill-400", code: "bad_request", message: "unknown field tenant" });
      return json(201, { evaluated_at: TS, action: makeHandOff("drill", `scripts/tb drill repo=${String(body.repo)}`, String(body.target ?? "latest")) });
    }

    if (path === "/api/ops/v1/runbooks") {
      return json(200, {
        evaluated_at: TS,
        bundle_sha: "8f2a10c",
        deployed_sha: "7d1b09a",
        stale_warning: "Runbook bundle SHA (8f2a10c) differs from deployed SHA (7d1b09a).",
        docs: Object.values(data.oc1.runbooks).map((d) => ({ path: d.path, anchors: d.anchors })),
      });
    }
    if (path.startsWith("/api/ops/v1/runbooks/")) {
      runbookPaths.push(path);
      if (path.includes("%2F") || path.includes("%2f")) {
        return json(404, { evaluated_at: TS, support_ref: "sup-rb-404", code: "OPS_RUNBOOK_NOT_FOUND", message: "runbook not found" });
      }
      const docPath = path.slice("/api/ops/v1/runbooks/".length);
      const doc = data.oc1.runbooks[docPath];
      if (!doc) return json(404, { evaluated_at: TS, support_ref: "sup-rb-404", code: "OPS_RUNBOOK_NOT_FOUND", message: "runbook not found" });
      return json(200, { evaluated_at: TS, bundle_sha: "8f2a10c", deployed_sha: "7d1b09a", stale_warning: "Runbook bundle SHA (8f2a10c) differs from deployed SHA (7d1b09a).", doc });
    }

    if (path === "/api/ops/v1/obligations" && method === "GET") {
      if (overrides.brokenObligationChain) {
        return json(200, {
          evaluated_at: TS,
          verdict: { text: "Unknown: record chain broken at 2", worst: "Unknown" },
          launch_readiness: { text: "Unknown: record chain broken at 2", worst: "Unknown" },
          items: [],
          count: unk("record chain broken", "obligations"),
          sources: [{ name: "obligations", kind: "obligations", producer: "spool", interval: 60, observed_at: null, age: 0, state: "Unknown", reason: "record chain broken at 2" }],
        });
      }
      const kind = url.searchParams.get("kind");
      const state = url.searchParams.get("state");
      const filtered = data.oc1.obligations.filter((it) => (!kind || it.kind === kind) && (!state || it.state === state));
      return json(200, {
        evaluated_at: TS,
        verdict: { text: "Blocked: 1 open launch gate", worst: "Degraded" },
        launch_readiness: { text: "Blocked: 1 open launch gate", worst: "Degraded" },
        items: filtered,
        count: ok(filtered.length, "obligations"),
        sources: [{ name: "obligations", kind: "obligations", producer: "spool", interval: 60, observed_at: TS, age: 5, state: "Verified", reason: null }],
      });
    }
    if (path === "/api/ops/v1/obligations" && method === "POST") {
      const body = req.postDataJSON() as S["OpenObligationRequest"];
      const id = `OBL-${String(data.oc1.obligations.length + 1).padStart(4, "0")}`;
      const item: S["ObligationItem"] = {
        id,
        kind: body.kind,
        reviewer_role: body.reviewer_role,
        title: body.title,
        due: body.due ?? null,
        state: "open",
        evidence_ref: body.evidence_ref ?? null,
        signer: null,
        signed_on: null,
        deadline: body.due ? "D-5" : "Unknown: no due date",
      };
      const record: S["ObligationRecord"] = {
        seq: 1,
        hash: `h-${id}`,
        support_ref: `sup-${id}`,
        at: TS,
        operator: { person: data.me.operator.person, method: "access-jwt" },
        obligation_id: id,
        event: "opened",
        fields: body as unknown as Record<string, never>,
      };
      data.oc1.obligations.unshift(item);
      data.oc1.obligationHistory[id] = [record];
      return json(201, { evaluated_at: TS, id, item, record });
    }
    if (path.startsWith("/api/ops/v1/obligations/") && path.endsWith("/events") && method === "POST") {
      const id = path.slice("/api/ops/v1/obligations/".length, -"/events".length);
      const item = data.oc1.obligations.find((o) => o.id === id);
      if (!item) return json(404, { evaluated_at: TS, support_ref: "sup-obl-404", code: "OPS_OBLIGATION_NOT_FOUND", message: "obligation not found" });
      const body = req.postDataJSON() as { event: "in_review" | "redated" | "done" | "waived" | "countersigned"; fields: Record<string, string> };
      const isStructuredRef = (raw: string | undefined) =>
        Boolean(raw && !/\s/.test(raw) && !raw.includes("..") && (/^https:\/\/[^/]+\/.+/.test(raw) || /^docs\/.+/.test(raw) || /^ops\/.+/.test(raw)));
      const isGateDecision = item.kind === "launch-gate" && (body.event === "done" || body.event === "waived");
      if (isGateDecision) {
        if (body.event === "waived" ? !body.fields.reason || !body.fields.counsel_url : !body.fields.evidence_ref || !body.fields.signed_on) {
          return json(422, { evaluated_at: TS, support_ref: "sup-obl-422", code: "OPS_OBLIGATION_INCOMPLETE", message: "Missing gate evidence." });
        }
        if (body.fields.signer || body.fields.co_signer || !isStructuredRef(body.fields.counsel_url || body.fields.evidence_ref)) {
          return json(400, { evaluated_at: TS, support_ref: "sup-obl-400", code: "OPS_OBLIGATION_INVALID", message: "Invalid gate proposal." });
        }
      }
      if (body.event === "in_review") item.state = "in-review";
      else if (body.event === "done") {
        item.state = "done";
        item.evidence_ref = body.fields.evidence_ref ?? null;
        item.signer = body.fields.signer ?? null;
        item.co_signer = body.fields.co_signer ?? null;
        item.counsel_url = body.fields.counsel_url ?? null;
        item.signed_on = body.fields.signed_on ?? null;
      } else if (body.event === "waived") {
        item.state = "waived";
        item.signer = body.fields.signer ?? null;
        item.co_signer = body.fields.co_signer ?? null;
        item.counsel_url = body.fields.counsel_url ?? null;
      } else if (body.event === "redated") {
        item.due = body.fields.due ?? item.due;
      }
      const hist = data.oc1.obligationHistory[id] ?? [];
      if (isGateDecision && (body.event === "done" || body.event === "waived")) {
        item.state = "in-review";
        item.signer = data.me.operator.person;
        item.pending_signoff = { seq: hist.length + 1, outcome: body.event, reason: body.fields.reason ?? null };
      } else if (body.event === "countersigned") {
        const pending = item.pending_signoff;
        if (!pending || pending.seq !== Number(body.fields.proposal_seq) || item.signer === data.me.operator.person) {
          return json(400, { evaluated_at: TS, support_ref: "sup-obl-400", code: "OPS_OBLIGATION_INVALID", message: "Invalid countersignature." });
        }
        item.state = pending.outcome;
        item.co_signer = data.me.operator.person;
        delete item.pending_signoff;
      }
      const record: S["ObligationRecord"] = {
        seq: hist.length + 1,
        hash: `h-${id}-${hist.length + 1}`,
        support_ref: `sup-${id}-${hist.length + 1}`,
        at: TS,
        operator: { person: data.me.operator.person, method: "access-jwt" },
        obligation_id: id,
        event: body.event,
        fields: body.fields as unknown as Record<string, never>,
      };
      hist.push(record);
      data.oc1.obligationHistory[id] = hist;
      return json(200, { evaluated_at: TS, id, item, record });
    }
    if (path.startsWith("/api/ops/v1/obligations/") && method === "GET") {
      const id = path.slice("/api/ops/v1/obligations/".length);
      const item = data.oc1.obligations.find((o) => o.id === id) ?? null;
      if (!item) return json(404, { evaluated_at: TS, support_ref: "sup-obl-404", code: "OPS_OBLIGATION_NOT_FOUND", message: "obligation not found" });
      return json(200, {
        evaluated_at: TS,
        verdict: { text: "Blocked", worst: "Degraded" },
        item,
        history: data.oc1.obligationHistory[id] ?? [],
        sources: [{ name: "obligations", kind: "obligations", producer: "spool", interval: 60, observed_at: TS, age: 5, state: "Verified", reason: null }],
      });
    }

    if (path === "/api/ops/v1/incidents" && method === "GET") {
      return json(200, {
        evaluated_at: TS,
        incidents: data.oc1.incidents.map((i) => ({
          id: i.id, title: i.title, sev: i.sev, status: i.status, lead: i.lead,
          head_seq: i.head_seq, next_public_update_at: i.next_public_update_at, legal_clocks: i.legal_clocks,
        })),
        count: ok(data.oc1.incidents.length, "incidents"),
      });
    }
    if (path === "/api/ops/v1/incidents" && method === "POST") {
      const body = req.postDataJSON() as S["DeclareIncidentRequest"];
      const id = `INC-${String(data.oc1.incidents.length + 1).padStart(4, "0")}`;
      const inc: S["IncidentDetail"] = {
        id,
        title: body.title,
        sev: body.sev,
        status: "Investigating",
        lead: body.lead ?? null,
        affected_components: body.affected_components ?? [],
        personal_data_impact: body.personal_data_impact,
        intrusion: Boolean(body.intrusion),
        opened_at: TS,
        discovered_at: body.discovered_at,
        next_public_update_at: body.next_public_update_at ?? null,
        public_incident_id: body.public_incident_id ?? null,
        postmortem_ref: null,
        mitigations: [],
        timeline: [{ seq: 1, at: TS, actor: "oncall@cosskorea.invalid", kind: "declared", summary: `Declared ${body.sev}` }],
        head_seq: 1,
        head_hash: `inc-hash-${id}`,
        legal_clocks: body.intrusion ? [{ kind: "intrusion_24h", deadline: "2026-11-22T20:50:00Z", remaining_s: 82800, overdue: false }] : [],
      };
      data.oc1.incidents.unshift(inc);
      return json(201, { evaluated_at: TS, incident: inc });
    }
    if (path.startsWith("/api/ops/v1/incidents/") && path.endsWith("/events") && method === "POST") {
      const id = path.slice("/api/ops/v1/incidents/".length, -"/events".length);
      const inc = data.oc1.incidents.find((i) => i.id === id);
      if (!inc) return json(404, { evaluated_at: TS, support_ref: "sup-inc-404", code: "OPS_INCIDENT_NOT_FOUND", message: "incident not found" });
      if (conflictPending) {
        conflictPending = false;
        return json(409, { evaluated_at: TS, support_ref: "sup-inc-409", code: "OPS_INCIDENT_CONFLICT", message: "Sequence conflict; reload incident." });
      }
      const body = req.postDataJSON() as { event: string; fields: Record<string, string> };
      if ((body.event === "resolved" || (body.event === "status_changed" && body.fields.status === "Resolved")) && (inc.sev === "SEV1" || inc.sev === "SEV2") && !inc.postmortem_ref) {
        return json(409, { evaluated_at: TS, support_ref: "sup-pm-409", code: "OPS_POSTMORTEM_REQUIRED", message: "SEV1/SEV2 requires postmortem link before resolving." });
      }
      inc.head_seq += 1;
      if (body.event === "postmortem_linked") inc.postmortem_ref = body.fields.postmortem_ref ?? null;
      if (body.event === "resolved") inc.status = "Resolved";
      inc.timeline.push({ seq: inc.head_seq, at: TS, actor: "oncall@cosskorea.invalid", kind: body.event, summary: body.fields.note ?? body.fields.postmortem_ref ?? body.event });
      return json(200, { evaluated_at: TS, incident: inc });
    }
    if (path.startsWith("/api/ops/v1/incidents/") && path.endsWith("/public-draft") && method === "POST") {
      const id = path.slice("/api/ops/v1/incidents/".length, -"/public-draft".length);
      const inc = data.oc1.incidents.find((i) => i.id === id);
      if (!inc) return json(404, { evaluated_at: TS, support_ref: "sup-inc-404", code: "OPS_INCIDENT_NOT_FOUND", message: "incident not found" });
      const body = req.postDataJSON() as S["PublicDraftRequest"];
      inc.head_seq += 1;
      const action = makeHandOff("status-publish", `scripts/tb status publish --incident ${id} --rev ${body.rev}`, id);
      return json(201, { evaluated_at: TS, incident: inc, action });
    }
    if (path.startsWith("/api/ops/v1/incidents/") && method === "GET") {
      const id = path.slice("/api/ops/v1/incidents/".length);
      const inc = data.oc1.incidents.find((i) => i.id === id);
      if (!inc) return json(404, { evaluated_at: TS, support_ref: "sup-inc-404", code: "OPS_INCIDENT_NOT_FOUND", message: "incident not found" });
      return json(200, { evaluated_at: TS, incident: inc });
    }

    if (path === "/api/ops/v1/sources") return json(200, data.sources);

    if (path === "/api/ops/v1/events") {
      lastEventIds.push(req.headers()["last-event-id"]);
      const body = overrides.sseBody ?? `event: heartbeat\nid: 1\ndata: ${JSON.stringify({ type: "heartbeat", id: 1, evaluated_at: TS })}\n\n`;
      return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body });
    }

    unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "unmocked" }) });
  });

  return {
    data,
    unexpected,
    lastEventIds,
    alertDetailPaths,
    runbookPaths,
    getLastEventIds: () => page.evaluate(() => (window as unknown as { __opsSseLastEventIds?: (string | null)[] }).__opsSseLastEventIds ?? []),
    getSseConnectCount: () => page.evaluate(() => (window as unknown as { __opsSseConnectCount?: number }).__opsSseConnectCount ?? 0),
  };
}
