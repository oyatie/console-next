// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;

use console_ops_domain::ladders::{AlertState, EvidenceState, Severity, WorkKind};
use console_ops_domain::{Observed, ObservedTimestamp, Verdict};
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;

pub use crate::snapshot_running::{
    ComponentView, EvaluatedSnapshot, JobView, JobsView, Membership, RollupView, RunningView,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OperatorView {
    pub person: String,
    pub display_email: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GrantView {
    pub action: String,
    pub from: String,
    pub until: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MeView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub operator: OperatorView,
    pub grants: Vec<GrantView>,
    pub allowed_actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkView {
    pub href: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SourceKind {
    #[serde(rename = "alertmanager")]
    Alertmanager,
    #[serde(rename = "vmalert")]
    Vmalert,
    #[serde(rename = "victoriametrics")]
    VictoriaMetrics,
    #[serde(rename = "bundle")]
    Bundle,
    #[serde(rename = "textfile")]
    Textfile,
    #[serde(rename = "access_jwks")]
    AccessJwks,
    #[serde(rename = "evaluator")]
    Evaluator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceView {
    pub name: String,
    pub kind: SourceKind,
    pub producer: String,
    pub interval: u64,
    #[serde(with = "time::serde::rfc3339::option")]
    pub observed_at: Option<OffsetDateTime>,
    pub age: u64,
    pub state: EvidenceState,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceCountsView {
    #[serde(rename = "Verified")]
    pub verified: usize,
    #[serde(rename = "Monitoring")]
    pub monitoring: usize,
    #[serde(rename = "Stale")]
    pub stale: usize,
    #[serde(rename = "Unknown")]
    pub unknown: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceView {
    pub counts: EvidenceCountsView,
    pub sources: Vec<SourceView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourcesView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub sources: Vec<SourceView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkItemView {
    pub kind: WorkKind,
    pub title: Observed<String>,
    pub component: Observed<String>,
    pub state: Observed<Value>,
    pub since: ObservedTimestamp,
    pub age: Observed<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead: Option<Observed<String>>,
    pub next: LinkView,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChangingView {
    pub key: String,
    pub digest: Observed<String>,
    pub colour: Observed<String>,
    pub canary_step: Observed<String>,
    pub bundle_sha: Observed<String>,
    pub preview_candidate: Observed<String>,
    pub maintenance_window: Observed<String>,
    pub weight_percent: Observed<f64>,
    pub watch_until: ObservedTimestamp,
    pub freeze: Observed<bool>,
    pub next: LinkView,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BudgetView {
    pub key: String,
    pub remaining_percent: Observed<f64>,
    pub burn_1h: Observed<f64>,
    pub burn_6h: Observed<f64>,
    pub exhaustion_s: Observed<f64>,
    pub requests_30d: Observed<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DataSafetyView {
    pub repository: String,
    pub rpo_s: Observed<f64>,
    pub limit_s: Observed<f64>,
    pub last_base_backup: ObservedTimestamp,
    pub last_proven_restore: ObservedTimestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FreeTierMeterView {
    pub key: String,
    pub used: Observed<f64>,
    pub limit: Observed<f64>,
    pub warning_ratio: Observed<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CostView {
    pub key: String,
    pub mtd: Observed<f64>,
    pub lag_s: Observed<u64>,
    pub billed_skus: Observed<u64>,
    pub limits: Vec<FreeTierMeterView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HomeSnapshotView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub verdict: Verdict,
    pub worklist: Vec<WorkItemView>,
    pub changing: Vec<ChangingView>,
    pub budgets: Vec<BudgetView>,
    pub data_safety: Vec<DataSafetyView>,
    pub cost: Vec<CostView>,
    pub evidence: EvidenceView,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValueVsThresholdView {
    pub value: Observed<f64>,
    pub threshold: Observed<f64>,
    pub operator: Observed<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertGroupView {
    pub key: String,
    pub alertname: String,
    pub component: Observed<String>,
    pub severity: Observed<Severity>,
    pub state: Observed<AlertState>,
    pub since: ObservedTimestamp,
    pub members_n: Observed<usize>,
    pub summary: Observed<String>,
    pub value_vs_threshold: ValueVsThresholdView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead: Option<Observed<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertGroupsView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub groups: Vec<AlertGroupView>,
    pub count: Observed<usize>,
    pub alert_count: Observed<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RuleView {
    pub expression: Observed<String>,
    pub current_value: Observed<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertMemberView {
    pub fingerprint: String,
    pub labels: BTreeMap<String, String>,
    pub state: Observed<AlertState>,
    pub since: ObservedTimestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChangeView {
    pub at: ObservedTimestamp,
    pub summary: Observed<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertGroupDetailView {
    #[serde(flatten)]
    pub summary_group: AlertGroupView,
    pub impact: Observed<String>,
    pub probable_cause: Observed<String>,
    pub first_action: Observed<String>,
    pub notices: Vec<Observed<String>>,
    pub rule: RuleView,
    pub members: Vec<AlertMemberView>,
    pub changes: Vec<ChangeView>,
    pub links: Vec<Observed<String>>,
    pub footer_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertDetailView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub group: AlertGroupDetailView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MatcherView {
    pub name: String,
    pub value: String,
    pub is_regex: bool,
    pub is_equal: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SilenceView {
    pub id: String,
    pub matchers: Vec<MatcherView>,
    pub starts: ObservedTimestamp,
    pub ends: ObservedTimestamp,
    pub author: Observed<String>,
    pub comment: Observed<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SilencesView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub silences: Vec<SilenceView>,
    pub count: Observed<usize>,
}
