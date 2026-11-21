// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_domain::bundle::OpsSettings;
use console_ops_domain::ladders::{AlertState, EvidenceState, JobState, Severity, WorkKind};
use time::OffsetDateTime;

use crate::snapshot::{AlertGroupsView, JobsView, LinkView, SourceKind, SourceView, WorkItemView};
use crate::sources_status::{ExternalSourceStatus, SourceSlot, sanitize_text};
use crate::victoriametrics::{QUERY_NODE_TEXTFILE_MTIME, VictoriaMetricsSnapshot};
use crate::{AlertmanagerSnapshot, VmalertSnapshot};

pub(crate) fn build_worklist(
    alerts: &AlertGroupsView,
    jobs: &JobsView,
    alertmanager: &SourceSlot<AlertmanagerSnapshot>,
    victoriametrics: &SourceSlot<VictoriaMetricsSnapshot>,
    now: OffsetDateTime,
) -> Vec<WorkItemView> {
    let mut worklist = Vec::new();
    for g in &alerts.groups {
        if !g.state.value().is_some_and(|s| *s != AlertState::Resolved) {
            continue;
        }
        let kind = match g.severity.value().copied() {
            Some(Severity::Page) | None => WorkKind::Page,
            Some(Severity::Ticket) => WorkKind::Ticket,
        };
        let age = g.since.value().map(|since| {
            u64::try_from((now - since.into_inner()).whole_seconds()).unwrap_or_default()
        });
        worklist.push(WorkItemView {
            kind,
            title: g.summary.clone(),
            component: g.component.clone(),
            state: g
                .state
                .clone()
                .map(|s| serde_json::to_value(s).unwrap_or_default()),
            since: g.since.clone(),
            age: alertmanager.observe(age, Some("s".into()), now),
            lead: g.lead.clone(),
            next: LinkView {
                href: format!("/alerts/{}", g.key),
                label: "Read alert".to_owned(),
            },
        });
    }
    for job in &jobs.jobs {
        if let Some(state @ (JobState::Failed | JobState::Late)) = job.state.value().copied() {
            let kind = if state == JobState::Failed {
                WorkKind::Overdue
            } else {
                WorkKind::Due
            };
            let age = job.last_run.value().map(|at| {
                u64::try_from((now - at.into_inner()).whole_seconds()).unwrap_or_default()
            });
            worklist.push(WorkItemView {
                kind,
                title: victoriametrics.observe(Some(format!("Job {}", job.name)), None, now),
                component: victoriametrics.observe(Some(job.name.clone()), None, now),
                state: job
                    .state
                    .clone()
                    .map(|s| serde_json::to_value(s).unwrap_or_default()),
                since: job.last_run.clone(),
                age: victoriametrics.observe(age, Some("s".into()), now),
                lead: None,
                next: LinkView {
                    href: "/running/jobs".to_owned(),
                    label: "Inspect job".to_owned(),
                },
            });
        }
    }
    worklist.sort_by_key(|item| item.kind);
    worklist
}

pub(crate) struct SourcesInputs<'a> {
    pub alertmanager: &'a SourceSlot<AlertmanagerSnapshot>,
    pub vmalert: &'a SourceSlot<VmalertSnapshot>,
    pub victoriametrics: &'a SourceSlot<VictoriaMetricsSnapshot>,
    pub access_jwks_status: &'a ExternalSourceStatus,
    pub settings: &'a OpsSettings,
    pub bundle_observed_at: OffsetDateTime,
    pub evaluator_observed_at: Option<OffsetDateTime>,
}

pub(crate) fn collect_sources(
    inputs: SourcesInputs<'_>,
    now: OffsetDateTime,
    disagreement: Option<&str>,
) -> Vec<SourceView> {
    let mut am_view = inputs.alertmanager.source_view(now);
    if let Some(reason) = disagreement {
        am_view.state = EvidenceState::Unknown;
        am_view.reason = Some(reason.to_owned());
    }
    let bundle_interval = NonZeroU64::new(86_400).unwrap_or(NonZeroU64::MIN);
    let eval_interval = inputs
        .settings
        .budgets
        .get("evaluate_interval_s")
        .copied()
        .unwrap_or(inputs.alertmanager.interval_s);
    let mut sources = vec![
        am_view,
        inputs.vmalert.source_view(now),
        inputs.victoriametrics.source_view(now),
        ExternalSourceStatus {
            name: "bundle".to_owned(),
            kind: SourceKind::Bundle,
            producer: "config-bundle".to_owned(),
            interval_s: bundle_interval,
            observed_at: Some(inputs.bundle_observed_at),
            error: None,
        }
        .into_view(now),
        inputs.access_jwks_status.into_view(now),
        ExternalSourceStatus {
            name: "evaluator".to_owned(),
            kind: SourceKind::Evaluator,
            producer: "console-app-ops".to_owned(),
            interval_s: eval_interval,
            observed_at: inputs.evaluator_observed_at,
            error: None,
        }
        .into_view(now),
    ];
    if let Some(snap) = inputs.victoriametrics.current.as_ref() {
        for sample in snap
            .series
            .get(QUERY_NODE_TEXTFILE_MTIME)
            .into_iter()
            .flatten()
        {
            let collector = sample
                .metric
                .get("collector")
                .or_else(|| sample.metric.get("file"))
                .and_then(|v| sanitize_text(v))
                .unwrap_or_else(|| "textfile".to_owned());
            let obs_at = OffsetDateTime::from_unix_timestamp(sample.value as i64).ok();
            sources.push(
                ExternalSourceStatus {
                    name: format!("textfile:{collector}"),
                    kind: SourceKind::Textfile,
                    producer: "node-exporter".to_owned(),
                    interval_s: inputs.victoriametrics.interval_s,
                    observed_at: obs_at,
                    error: obs_at.is_none().then(|| "invalid mtime".to_owned()),
                }
                .into_view(now),
            );
        }
    }
    sources
}
