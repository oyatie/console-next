// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;

use console_ops_domain::ladders::{Drift, Health, JobState};
use console_ops_domain::{Observed, ObservedTimestamp};
use serde::Serialize;
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Membership {
    Declared,
    Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ComponentView {
    pub key: String,
    pub group: String,
    pub host: String,
    pub health: Observed<Health>,
    pub drift: Observed<Drift>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<Observed<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<Observed<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<ObservedTimestamp>,
    pub source: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub observed_at: Option<OffsetDateTime>,
    pub age: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<Observed<String>>,
    pub runbook: Observed<String>,
    pub membership: Membership,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RollupView {
    pub key: String,
    pub health: Observed<Health>,
    pub drift: Observed<Drift>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunningView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub components: Vec<ComponentView>,
    pub hosts: Vec<RollupView>,
    pub groups: Vec<RollupView>,
    pub count: Observed<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JobView {
    pub name: String,
    pub state: Observed<JobState>,
    pub last_run: ObservedTimestamp,
    pub last_exit: Observed<f64>,
    pub budget: Observed<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run: Option<ObservedTimestamp>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JobsView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub jobs: Vec<JobView>,
    pub count: Observed<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EvaluatedSnapshot {
    pub evaluated_at: OffsetDateTime,
    pub home: crate::snapshot::HomeSnapshotView,
    pub alerts: crate::snapshot::AlertGroupsView,
    pub alert_details: BTreeMap<String, crate::snapshot::AlertGroupDetailView>,
    pub silences: crate::snapshot::SilencesView,
    pub running: RunningView,
    pub jobs: JobsView,
    pub sources: crate::snapshot::SourcesView,
}
