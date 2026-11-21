// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;

use console_ops_domain::Observed;
use console_ops_domain::ladders::AlertState;

use crate::events::{DeltaRingBuffer, OpsEvent};
use crate::snapshot::{ComponentView, EvaluatedSnapshot, JobView, SourceView};

pub fn diff_and_push(
    ring: &mut DeltaRingBuffer,
    prev: &EvaluatedSnapshot,
    next: &EvaluatedSnapshot,
) -> Vec<OpsEvent> {
    let mut emitted = Vec::new();
    let at = next.evaluated_at;

    if prev.home.verdict != next.home.verdict
        || prev.home.worklist.len() != next.home.worklist.len()
        || prev.home.evidence.counts != next.home.evidence.counts
    {
        emitted.push(ring.push(OpsEvent::HomeChanged {
            id: 0,
            evaluated_at: at,
            home: next.home.clone(),
        }));
    }

    for (key, next_detail) in &next.alert_details {
        let changed = match prev.alert_details.get(key) {
            None => true,
            Some(prev_detail) => {
                prev_detail.summary_group.state.state() != next_detail.summary_group.state.state()
                    || prev_detail.summary_group.state.value()
                        != next_detail.summary_group.state.value()
                    || prev_detail.summary_group.members_n.value()
                        != next_detail.summary_group.members_n.value()
            }
        };
        if changed {
            emitted.push(ring.push(OpsEvent::AlertGroupChanged {
                id: 0,
                evaluated_at: at,
                group: next_detail.clone(),
            }));
        }
    }
    for (key, prev_detail) in &prev.alert_details {
        if !next.alert_details.contains_key(key) {
            let mut resolved = prev_detail.clone();
            resolved.summary_group.state = Observed::current(
                AlertState::Resolved,
                None,
                resolved.summary_group.state.source().to_owned(),
                at,
                at,
                std::num::NonZeroU64::MIN,
            );
            emitted.push(ring.push(OpsEvent::AlertGroupResolved {
                id: 0,
                evaluated_at: at,
                group: resolved,
            }));
        }
    }

    let prev_comps: BTreeMap<&str, &ComponentView> = prev
        .running
        .components
        .iter()
        .map(|c| (c.key.as_str(), c))
        .collect();
    for comp in &next.running.components {
        let changed = match prev_comps.get(comp.key.as_str()) {
            None => true,
            Some(old) => {
                old.health.state() != comp.health.state()
                    || old.health.value() != comp.health.value()
                    || old.drift.state() != comp.drift.state()
                    || old.drift.value() != comp.drift.value()
                    || old.membership != comp.membership
            }
        };
        if changed {
            emitted.push(ring.push(OpsEvent::ComponentChanged {
                id: 0,
                evaluated_at: at,
                component: comp.clone(),
            }));
        }
    }

    let prev_jobs: BTreeMap<&str, &JobView> = prev
        .jobs
        .jobs
        .iter()
        .map(|j| (j.name.as_str(), j))
        .collect();
    for job in &next.jobs.jobs {
        let changed = match prev_jobs.get(job.name.as_str()) {
            None => true,
            Some(old) => {
                old.state.state() != job.state.state()
                    || old.state.value() != job.state.value()
                    || old.last_exit.value() != job.last_exit.value()
            }
        };
        if changed {
            emitted.push(ring.push(OpsEvent::JobChanged {
                id: 0,
                evaluated_at: at,
                job: job.clone(),
            }));
        }
    }

    let prev_sources: BTreeMap<&str, &SourceView> = prev
        .sources
        .sources
        .iter()
        .map(|s| (s.name.as_str(), s))
        .collect();
    for src in &next.sources.sources {
        let changed = match prev_sources.get(src.name.as_str()) {
            None => true,
            Some(old) => old.state != src.state || old.reason != src.reason,
        };
        if changed {
            emitted.push(ring.push(OpsEvent::SourceChanged {
                id: 0,
                evaluated_at: at,
                source: src.clone(),
            }));
        }
    }

    emitted
}
