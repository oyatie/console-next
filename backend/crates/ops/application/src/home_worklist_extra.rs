// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_domain::ladders::{IncidentSeverity, WorkKind};
use console_ops_domain::{Observed, UtcTimestamp};
use time::OffsetDateTime;

use crate::actions::{ActionRecord, ActionStatus};
use crate::changes::HostStateStore;
use crate::incidents::IncidentSummaryView;
use crate::snapshot::{ChangeView, LinkView, WorkItemView};
use crate::sources_status::SourceSlot;
use crate::victoriametrics::{QUERY_CONFIG_LAST_TS, QUERY_DEPLOY_LAST_TS, VictoriaMetricsSnapshot};

pub fn build_incident_home_worklist(
    incidents: &[IncidentSummaryView],
    opened_at_map: &std::collections::BTreeMap<String, OffsetDateTime>,
    now: OffsetDateTime,
    interval_s: NonZeroU64,
) -> Vec<WorkItemView> {
    incidents
        .iter()
        .filter(|inc| inc.status != console_ops_domain::ladders::Incident::Resolved)
        .map(|inc| {
            let update_overdue = inc
                .next_public_update_at
                .is_some_and(|next_at| *next_at <= now);
            let legal_overdue = inc.legal_clocks.iter().any(|c| c.overdue);
            let kind = if matches!(inc.sev, IncidentSeverity::Sev1 | IncidentSeverity::Sev2)
                || update_overdue
            {
                WorkKind::Page
            } else if legal_overdue {
                WorkKind::Overdue
            } else {
                WorkKind::Due
            };
            let since_at = opened_at_map.get(&inc.id).copied().unwrap_or(now);
            let age_s = u64::try_from((now - since_at).whole_seconds()).unwrap_or_default();
            WorkItemView {
                kind,
                title: Observed::current(
                    format!("{}: {}", inc.id, inc.title),
                    None,
                    "incidents".to_owned(),
                    now,
                    now,
                    interval_s,
                ),
                component: Observed::current(
                    "incident".to_owned(),
                    None,
                    "incidents".to_owned(),
                    now,
                    now,
                    interval_s,
                ),
                state: Observed::current(
                    serde_json::to_value(inc.status).unwrap_or_default(),
                    None,
                    "incidents".to_owned(),
                    now,
                    now,
                    interval_s,
                ),
                since: Observed::current(
                    UtcTimestamp::new(since_at),
                    None,
                    "incidents".to_owned(),
                    now,
                    now,
                    interval_s,
                ),
                age: Observed::current(
                    age_s,
                    Some("s".to_owned()),
                    "incidents".to_owned(),
                    now,
                    now,
                    interval_s,
                ),
                lead: inc.lead.as_ref().map(|l| {
                    Observed::current(
                        l.clone(),
                        None,
                        "incidents".to_owned(),
                        now,
                        now,
                        interval_s,
                    )
                }),
                next: LinkView {
                    href: format!("/incidents/{}", inc.id),
                    label: "Manage incident".to_owned(),
                },
            }
        })
        .collect()
}

pub fn build_action_home_worklist(
    actions: &[ActionRecord],
    now: OffsetDateTime,
    interval_s: NonZeroU64,
) -> Vec<WorkItemView> {
    actions
        .iter()
        .filter(|a| a.status == ActionStatus::Pending)
        .map(|a| {
            let age_s = u64::try_from((now - *a.at).whole_seconds()).unwrap_or_default();
            WorkItemView {
                kind: WorkKind::Due,
                title: Observed::current(
                    format!("Pending Cmd: {} ({})", a.handoff.kind, a.handoff.target),
                    None,
                    "actions".to_owned(),
                    now,
                    now,
                    interval_s,
                ),
                component: Observed::current(
                    a.handoff.kind.clone(),
                    None,
                    "actions".to_owned(),
                    now,
                    now,
                    interval_s,
                ),
                state: Observed::current(
                    serde_json::json!("Pending"),
                    None,
                    "actions".to_owned(),
                    now,
                    now,
                    interval_s,
                ),
                since: Observed::current(a.at, None, "actions".to_owned(), now, now, interval_s),
                age: Observed::current(
                    age_s,
                    Some("s".to_owned()),
                    "actions".to_owned(),
                    now,
                    now,
                    interval_s,
                ),
                lead: Some(Observed::current(
                    a.operator.clone(),
                    None,
                    "actions".to_owned(),
                    now,
                    now,
                    interval_s,
                )),
                next: LinkView {
                    href: "/actions".to_owned(),
                    label: "Run signed command".to_owned(),
                },
            }
        })
        .collect()
}

pub(crate) fn collect_recent_changes(
    vm: &SourceSlot<VictoriaMetricsSnapshot>,
    host_state: Option<&dyn HostStateStore>,
    now: OffsetDateTime,
) -> Vec<ChangeView> {
    let mut out = Vec::new();
    if let Some(host) = host_state {
        if let Some(deploys) = host.read_deploy_history() {
            for d in deploys {
                out.push(ChangeView {
                    at: vm.observe(Some(d.at), None, now),
                    summary: vm.observe(Some(d.message), None, now),
                });
            }
        }
        if let Some(configs) = host.read_config_history() {
            for c in configs {
                out.push(ChangeView {
                    at: vm.observe(Some(c.at), None, now),
                    summary: vm.observe(Some(c.message), None, now),
                });
            }
        }
    }
    if let Some(snap) = vm.current.as_ref() {
        for (q, label) in [
            (QUERY_DEPLOY_LAST_TS, "Deploy completed"),
            (QUERY_CONFIG_LAST_TS, "Config bundle applied"),
        ] {
            if let Some(ts) = snap
                .series
                .get(q)
                .and_then(|v| v.first())
                .and_then(|s| OffsetDateTime::from_unix_timestamp(s.value as i64).ok())
                .map(UtcTimestamp::new)
            {
                out.push(ChangeView {
                    at: vm.observe(Some(ts), None, now),
                    summary: vm.observe(Some(label.to_owned()), None, now),
                });
            }
        }
    }
    out
}
