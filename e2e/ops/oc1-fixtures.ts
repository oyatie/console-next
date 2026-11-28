// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/ops-schema";

type S = components["schemas"];
type Obs<T> = S["Observation"] & { value: T | null };

const TS = "2026-11-21T21:40:00Z";

function ok<T>(value: T, source = "evaluator", unit: string | null = null): Obs<T> {
  return { state: "Verified", value, unit, source, observed_at: TS, age_s: 12, reason: null };
}

function unk<T>(reason: string, source = "dr-rehearse"): Obs<T> {
  return { state: "Unknown", value: null, unit: null, source, observed_at: null, age_s: 0, reason };
}

export const ALL_OC1_ACTIONS = [
  "read.me", "read.home", "read.alerts", "read.running", "read.sources",
  "obligation.read", "obligation.write", "alert.ack", "alert.silence",
  "incident.write", "incident.publish", "promotion.signoff", "review.signoff",
  "feedback.triage", "jobs.rerun", "recovery.read",
  "change.request.backup-now", "change.request.canary-abort",
  "change.request.canary-hold", "change.request.canary-promote",
  "change.request.drill", "change.request.drill-at", "change.request.freeze",
  "change.request.promote", "change.request.rollback", "change.request.unfreeze",
];

export function buildOc1Fixtures() {
  const obligations: S["ObligationItem"][] = [
    {
      id: "OBL-0001",
      kind: "launch-gate",
      reviewer_role: "owner",
      title: "Production PITR drill signoff",
      due: "2026-11-24",
      state: "open",
      evidence_ref: null,
      signer: null,
      signed_on: null,
      deadline: "D-3",
    },
    {
      id: "OBL-0002",
      kind: "professional-review",
      reviewer_role: "labor-attorney",
      title: "Statutory wage calculation review",
      due: "2026-11-20",
      state: "in-review",
      evidence_ref: "doc-review-102",
      signer: null,
      signed_on: null,
      deadline: "D+1",
    },
    {
      id: "OBL-0003",
      kind: "credential-rotation",
      reviewer_role: "owner",
      title: "Cloudflare Access key rotation",
      due: "2026-11-18",
      state: "done",
      evidence_ref: "rot-2026-11-18",
      signer: "oncall@cosskorea.invalid",
      signed_on: "2026-11-18",
      deadline: "D+3",
    },
  ];

  const obligationHistory: Record<string, S["ObligationRecord"][]> = {
    "OBL-0001": [
      {
        seq: 1,
        hash: "h-obl-1",
        support_ref: "sup-obl-1",
        at: "2026-11-20T09:00:00Z",
        operator: { person: "11111111-1111-4111-8111-111111111111", method: "access-jwt" },
        obligation_id: "OBL-0001",
        event: "opened",
        fields: { title: "Production PITR drill signoff" } as unknown as Record<string, never>,
      },
    ],
    "OBL-0002": [
      {
        seq: 2,
        hash: "h-obl-2",
        support_ref: "sup-obl-2",
        at: "2026-11-21T10:00:00Z",
        operator: { person: "11111111-1111-4111-8111-111111111111", method: "access-jwt" },
        obligation_id: "OBL-0002",
        event: "in_review",
        fields: { note: "Assigned to external labor counsel" } as unknown as Record<string, never>,
      },
    ],
    "OBL-0003": [],
  };

  const health: S["ServiceHealthView"] = {
    evaluated_at: TS,
    internal_slos: [
      {
        key: "api-availability",
        remaining_percent: ok(64.5, "victoriametrics", "%"),
        burn_30m: ok(1.8, "victoriametrics", "x"),
        burn_1h: ok(2.4, "victoriametrics", "x"),
        burn_6h: ok(1.1, "victoriametrics", "x"),
        burn_3d: ok(0.8, "victoriametrics", "x"),
        burn_30d: ok(0.6, "victoriametrics", "x"),
        exhaustion_s: ok(28800, "victoriametrics", "s"),
        requests_30d: ok(4250000, "victoriametrics"),
        low_sample: false,
        low_sample_note: null,
      },
      {
        key: "auth-slo",
        remaining_percent: ok(98.2, "victoriametrics", "%"),
        burn_30m: ok(0.2, "victoriametrics", "x"),
        burn_1h: ok(0.2, "victoriametrics", "x"),
        burn_6h: ok(0.3, "victoriametrics", "x"),
        burn_3d: ok(0.4, "victoriametrics", "x"),
        burn_30d: ok(0.5, "victoriametrics", "x"),
        exhaustion_s: ok(2592000, "victoriametrics", "s"),
        requests_30d: ok(12400, "victoriametrics"),
        low_sample: true,
        low_sample_note: "Low sample volume (<50k requests / 30d)",
      },
    ],
    page_load_error_rate_5m: ok(0.02, "victoriametrics", "%"),
    page_loads_rate_5m: ok(18.4, "victoriametrics", "/s"),
    evidence_truth: [
      { source: "victoriametrics", ok: ok(true, "victoriametrics") },
      { source: "alertmanager", ok: ok(true, "alertmanager") },
      { source: "storage/pgbackrest", ok: ok(true, "textfile") },
    ],
    textfiles: [
      { file: "pgbackrest.prom", age_s: ok(45, "textfile", "s"), max_age_s: ok(300, "textfile", "s") },
      { file: "oncall.prom", age_s: ok(120, "textfile", "s"), max_age_s: ok(3600, "textfile", "s") },
    ],
    public_status: {
      feed_ok: ok(true, "status_feed"),
      revision: ok(14, "status_feed"),
      published_at: ok("2026-11-21T21:35:00Z", "status_feed"),
      observed_at: ok(TS, "status_feed"),
      expires_at: ok("2026-11-22T21:35:00Z", "status_feed"),
      unknown_components: ok(0, "status_feed"),
      components: {
        "api-gateway": ok("Operational", "status_feed"),
        "web-app": ok("Degraded performance", "status_feed"),
      },
    },
  };

  const oncall: S["OncallView"] = {
    evaluated_at: TS,
    config: {
      version: 1,
      mode: "single-operator",
      display_status: "Single operator on call",
      timezone: "Asia/Seoul",
      rotation: {
        primary_person: "11111111-1111-4111-8111-111111111111",
        backup_person: null,
        handoff_weekday: "Mon",
        handoff_hour_local: 9,
      },
      escalation: {
        ack_timeout_s: 300,
        repeat_interval_s: 900,
        out_of_hours_policy: "sev1-symptoms-only",
        daily_page_budget: 2,
      },
      synthetic_page_test: {
        enabled: true,
        schedule: "weekly",
        weekday: "Wed",
        hour_utc: 2,
        max_delivery_lag_s: 120,
      },
    } as unknown as Record<string, never>,
    active_shift: {
      active_person: "11111111-1111-4111-8111-111111111111",
      backup_person: null,
      shift_from: "2026-11-16T00:00:00Z",
      shift_until: "2026-11-23T00:00:00Z",
      shift_grants: ["alert.ack", "alert.silence", "incident.write"],
    },
    display_status: ok("Single operator on call", "oncall"),
    last_page_test_at: ok("2026-11-20T02:00:00Z", "textfile"),
    last_page_test_ok: ok(true, "textfile"),
  };

  const incidents: S["IncidentDetail"][] = [
    {
      id: "INC-0001",
      title: "Elevated 502 responses on api-canary",
      sev: "SEV1",
      status: "Investigating",
      lead: "oncall-lead",
      affected_components: ["console-api", "edge-proxy"],
      personal_data_impact: "unknown",
      intrusion: true,
      opened_at: "2026-11-21T20:55:00Z",
      discovered_at: "2026-11-21T20:50:00Z",
      next_public_update_at: "2026-11-21T22:00:00Z",
      public_incident_id: "ST-2026",
      postmortem_ref: null,
      mitigations: ["Held canary weight at 25%"],
      timeline: [
        { seq: 1, at: "2026-11-21T20:55:00Z", actor: "oncall-lead", kind: "declared", summary: "Declared SEV1 incident" },
      ],
      head_seq: 1,
      head_hash: "inc-hash-1",
      legal_clocks: [
        { kind: "intrusion_24h", deadline: "2026-11-22T20:50:00Z", remaining_s: 82800, overdue: false },
        { kind: "pipc_kisa_72h", deadline: "2026-11-24T20:50:00Z", remaining_s: 255600, overdue: false },
      ],
      public_card: {
        id: "ST-2026",
        title: { ko: "API delay notice", en: "API latency and elevated errors" },
        started_at: "2026-11-21T20:55:00Z",
        report_url: null,
        updates: [
          {
            n: 1,
            at: "2026-11-21T21:00:00Z",
            text: { ko: "Investigating", en: "Investigating elevated 502 responses." },
            stage: "investigating",
            components: { "api-gateway": "degraded" },
            next_update_by: "2026-11-21T22:00:00Z",
            correction_of: null,
          },
        ],
      } as unknown as Record<string, never>,
    },
  ];

  const digestA = `sha256:${"a".repeat(64)}`;
  const digestB = `sha256:${"b".repeat(64)}`;

  const changes: S["ChangesView"] = {
    evaluated_at: TS,
    releases: [
      {
        digest: digestA,
        state: "Verified",
        gates: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://cosskorea.com/attestations/console-gates/v1",
          subject: [{ name: "console-api", digest: { sha256: "a".repeat(64) } }],
          predicate: {
            inputs: {},
            gates: [
              { name: "ci-ok", result: "pass" },
              { name: "migration-safety", result: "pass" },
            ],
            runner: { kind: "github-actions" },
            bake: "normal",
          },
        } as unknown as Record<string, never>,
      },
      {
        digest: digestB,
        state: "Unknown",
        reason: "gate missing",
      },
    ],
    timeline: [
      { at: "2026-11-21T21:10:00Z", kind: "canary", summary: "Shifted canary weight to 25%", status: "active" },
    ],
    dora5: {
      deployment_frequency: ok(2.4, "releases", "/day"),
      lead_time_s: ok(1920, "releases", "s"),
      change_failure_rate: ok(0.05, "releases", "ratio"),
      mttr_s: ok(540, "incidents", "s"),
      rework_rate: ok(0.02, "releases", "ratio"),
      n: 12,
    },
    freeze: ok(false, "bundle"),
    canary_percent: ok(25, "bundle", "%"),
    bundle_sha: ok("8f2a10c", "bundle"),
  };

  const promote: S["PromoteView"] = {
    evaluated_at: TS,
    candidate_digest: ok(digestA, "bundle"),
    signed_bake: "normal",
    release_image: `registry.example/tenant/console-app@${digestA}`,
    state: { state: "Verified", value: "Blocked", unit: null, source: "promote", observed_at: TS, age_s: 5, reason: null },
    signoffs: [],
    feedback: [
      {
        seq: 1,
        hash: "fb-hash-1",
        support_ref: "sup-fb-1",
        at: "2026-11-21T20:00:00Z",
        operator: "qa-lead",
        feedback_id: "FB-101",
        digest: digestA,
        severity: "P1",
        disposition: "open",
        note: "Verify canary 5xx before promotion",
      },
    ],
  };

  const actions: S["ActionRecord"][] = [
    {
      seq: 1,
      hash: "act-hash-1",
      support_ref: "sup-act-1",
      status: "pending",
      action_id: "ACT-0001",
      kind: "canary-hold",
      command: "scripts/tb canary-hold --reason incident",
      target: "console-api",
      consequence: "Holds canary traffic at 25%",
      expected_result: "Canary stays at 25%",
      verify_step: "Check /changes canary weight",
      operator: "oncall@cosskorea.invalid",
      at: "2026-11-21T21:15:00Z",
    },
  ];

  const recovery: S["RecoveryView"] = {
    evaluated_at: TS,
    repos: [
      {
        repository: "repo-1",
        rpo_s: ok(45, "textfile", "s"),
        limit_s: ok(300, "textfile", "s"),
        last_base_backup: ok("2026-11-21T02:00:00Z", "textfile"),
        push_failures: unk("not instrumented", "textfile"),
      },
      {
        repository: "repo-2",
        rpo_s: ok(90, "textfile", "s"),
        limit_s: ok(900, "textfile", "s"),
        last_base_backup: ok("2026-11-21T02:30:00Z", "textfile"),
        push_failures: ok(0, "victoriametrics"),
      },
    ],
    rto: unk("Not measured", "dr-rehearse"),
    deferred_since: unk("none", "recovery"),
    last_exit_code: ok(0, "textfile"),
    lvm_snapshot_at: ok("2026-11-21T01:45:00Z", "textfile"),
    onprem_mount_expected: ok(true, "bundle"),
  };

  const runbooks: Record<string, S["RunbookDoc"]> = {
    "RUNBOOK.md": {
      path: "RUNBOOK.md",
      anchors: [
        { slug: "operations-runbook", kind: "heading", title: "Operations Runbook" },
        { slug: "triage-steps", kind: "heading", title: "Triage Steps" },
      ],
      content: [
        "# Operations Runbook",
        "",
        "Primary triage steps for CossKorea production services.",
        "",
        "## Triage Steps",
        "",
        "1. Inspect [Alerts](/alerts) and verify [XSS Probe](docs/ops/xss-probe.md).",
        "2. Check [Backup doc](https://github.com/oyatie/console-infra/blob/main/RUNBOOK.md).",
      ].join("\n"),
    },
    "docs/ops/xss-probe.md": {
      path: "docs/ops/xss-probe.md",
      anchors: [
        { slug: "safe-anchor", kind: "html_id", title: null },
        { slug: "xss-verification", kind: "heading", title: "XSS Verification" },
      ],
      content: [
        "# XSS Verification",
        "",
        '<a id="safe-anchor"></a>',
        '<script>window.__xss=1</script>',
        '<img src="x" onerror="window.__xss=2">',
        "[bad js](javascript:window.__xss=3)",
        "[bad data](data:text/html,<script>window.__xss=4</script>)",
        "",
        "| Check | Expected |",
        "| --- | --- |",
        "| Script tags | Escaped plain text |",
      ].join("\n"),
    },
  };

  return {
    obligations,
    obligationHistory,
    health,
    oncall,
    incidents,
    changes,
    promote,
    actions,
    recovery,
    runbooks,
  };
}
