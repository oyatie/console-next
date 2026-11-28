// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeSet;
use std::num::NonZeroU64;

use console_ops_domain::UtcTimestamp;
use console_ops_domain::changes::{
    CmdHandOff, ReleaseSample, compute_dora5, is_valid_sha256_digest,
};
use console_ops_domain::ladders::EvidenceState;
use time::OffsetDateTime;

use crate::actions::{ActionStore, CmdHandOffInput};
use crate::changes::{
    CanaryDecision, ChangeError, ChangesTimelineItem, ChangesView, HostStateStore, ReleaseGateView,
    ReleasesStore,
};
use crate::obligations::Context;
use crate::sources_status::SourceSlot;
use crate::victoriametrics::{
    QUERY_CONFIG_BUNDLE_INFO, QUERY_CONFIG_LAST_TS, QUERY_CONTAINER_INFO, QUERY_DEPLOY_LAST_TS,
    QUERY_PREVIEW_DIGEST_INFO, QUERY_ROLLOUT_CANARY_PERCENT, QUERY_ROLLOUT_WEIGHT_PERCENT,
    VictoriaMetricsSnapshot,
};

pub struct ChangesService<'a> {
    pub releases: Option<&'a dyn ReleasesStore>,
    pub host_state: Option<&'a dyn HostStateStore>,
    pub actions: &'a dyn ActionStore,
}

impl<'a> ChangesService<'a> {
    pub fn build_view(
        &self,
        vm: &SourceSlot<VictoriaMetricsSnapshot>,
        now: OffsetDateTime,
        interval_s: NonZeroU64,
    ) -> ChangesView {
        let mut releases = match self.releases.map(|r| r.list_releases()) {
            Some(Ok(list)) => list
                .into_iter()
                .map(|r| {
                    let state = if r.gates.is_some() {
                        EvidenceState::Verified
                    } else {
                        EvidenceState::Unknown
                    };
                    ReleaseGateView {
                        digest: r.digest,
                        state,
                        gates: r.gates,
                        reason: r.missing_reason,
                    }
                })
                .collect(),
            Some(Err(reason)) => vec![ReleaseGateView {
                digest: "unknown".to_owned(),
                state: EvidenceState::Unknown,
                gates: None,
                reason: Some(reason),
            }],
            None => Vec::new(),
        };
        let mut seen_digests: BTreeSet<String> =
            releases.iter().map(|r| r.digest.clone()).collect();
        if let Some(snap) = vm.current.as_ref() {
            let mut vm_digests = BTreeSet::new();
            for q in [
                QUERY_CONTAINER_INFO,
                QUERY_PREVIEW_DIGEST_INFO,
                QUERY_CONFIG_BUNDLE_INFO,
            ] {
                for s in snap.series.get(q).into_iter().flatten() {
                    if let Some(d) = s.metric.get("digest").map(|v| v.trim())
                        && is_valid_sha256_digest(d)
                    {
                        vm_digests.insert(d.to_owned());
                    }
                }
            }
            for digest in vm_digests {
                if seen_digests.insert(digest.clone()) {
                    releases.push(ReleaseGateView {
                        digest,
                        state: EvidenceState::Unknown,
                        gates: None,
                        reason: Some("gate missing".to_owned()),
                    });
                }
            }
        }

        let mut timeline = Vec::new();
        let mut samples = Vec::new();
        if let Some(host) = self.host_state {
            if let Some(deploys) = host.read_deploy_history() {
                for d in deploys {
                    let failed = d.result != "ok" && d.result != "success";
                    let rolled_back = d.message.contains("rollback");
                    if let Some(to) = &d.to_digest {
                        samples.push(ReleaseSample {
                            digest: to.clone(),
                            released_at: *d.at,
                            commit_at: None,
                            restored_at: None,
                            failed,
                            rolled_back,
                            rework: rolled_back,
                        });
                    }
                    timeline.push(ChangesTimelineItem {
                        at: d.at,
                        kind: "deploy".to_owned(),
                        summary: d.message,
                        status: d.result,
                    });
                }
            }
            if let Some(configs) = host.read_config_history() {
                for c in configs {
                    timeline.push(ChangesTimelineItem {
                        at: c.at,
                        kind: "config".to_owned(),
                        summary: format!("{}: {}", c.sha, c.message),
                        status: c.result,
                    });
                }
            }
        }
        if let Some(snap) = vm.current.as_ref() {
            for (q, kind) in [
                (QUERY_DEPLOY_LAST_TS, "deploy_metric"),
                (QUERY_CONFIG_LAST_TS, "config_metric"),
            ] {
                if let Some(ts) = snap
                    .series
                    .get(q)
                    .and_then(|v| v.first())
                    .and_then(|s| OffsetDateTime::from_unix_timestamp(s.value as i64).ok())
                {
                    timeline.push(ChangesTimelineItem {
                        at: UtcTimestamp::new(ts),
                        kind: kind.to_owned(),
                        summary: format!("Latest {kind} timestamp recorded"),
                        status: "observed".to_owned(),
                    });
                }
            }
        }
        timeline.sort_by_key(|a| std::cmp::Reverse(a.at));

        let dora5 = compute_dora5(&samples, "host-state", Some(now), now, interval_s);
        let canary_val = vm
            .current
            .as_ref()
            .and_then(|s| {
                s.series
                    .get(QUERY_ROLLOUT_CANARY_PERCENT)
                    .or_else(|| s.series.get(QUERY_ROLLOUT_WEIGHT_PERCENT))
            })
            .and_then(|v| v.first())
            .map(|s| s.value);
        let bundle_sha = vm
            .current
            .as_ref()
            .and_then(|s| s.series.get(QUERY_CONFIG_BUNDLE_INFO))
            .and_then(|v| v.first())
            .and_then(|s| s.metric.get("sha"))
            .cloned();

        ChangesView {
            evaluated_at: now,
            releases,
            timeline,
            dora5,
            freeze: vm.deployment_freeze(now),
            canary_percent: vm.observe(canary_val, Some("%".into()), now),
            bundle_sha: vm.observe(bundle_sha, None, now),
        }
    }

    pub fn request_rollback(
        &self,
        digest: &str,
        reason: &str,
        context: &Context,
    ) -> Result<CmdHandOff, ChangeError> {
        let trimmed = digest.trim();
        if !is_valid_sha256_digest(trimmed) || reason.trim().is_empty() {
            return Err(ChangeError::InvalidInput(
                "rollback requires sha256:<64-hex> digest and non-empty reason".to_owned(),
            ));
        }
        let cmd = format!(
            "APPROVER={} scripts/tb rollback {trimmed}",
            context.operator.person
        );
        let record = self.actions.record_handoff(
            &CmdHandOffInput {
                kind: "rollback",
                command: &cmd,
                target: trimmed,
                consequence: reason.trim(),
                expected_result: "Active serving digest switches back to target digest",
                verify_step: "Verify /running shows target digest Active and Synced",
            },
            context,
        )?;
        Ok(record.handoff)
    }

    pub fn request_canary(
        &self,
        decision: CanaryDecision,
        reason: &str,
        context: &Context,
    ) -> Result<CmdHandOff, ChangeError> {
        if reason.trim().is_empty() {
            return Err(ChangeError::InvalidInput(
                "canary decision requires non-empty reason".to_owned(),
            ));
        }
        let verb = decision.as_str();
        let cmd = format!("scripts/tb canary-{verb}");
        let kind = format!("canary-{verb}");
        let expected = format!("Canary rollout transitions per {verb}");
        let record = self.actions.record_handoff(
            &CmdHandOffInput {
                kind: &kind,
                command: &cmd,
                target: "canary",
                consequence: reason.trim(),
                expected_result: &expected,
                verify_step: "Verify /changes rollout weight and canary state",
            },
            context,
        )?;
        Ok(record.handoff)
    }

    pub fn request_freeze(
        &self,
        freeze: bool,
        reason: &str,
        context: &Context,
    ) -> Result<CmdHandOff, ChangeError> {
        if reason.trim().is_empty() {
            return Err(ChangeError::InvalidInput(
                "freeze toggle requires non-empty reason".to_owned(),
            ));
        }
        let verb = if freeze { "freeze" } else { "unfreeze" };
        let cmd = format!("scripts/tb {verb}");
        let expected = format!("Deploy freeze state set to {freeze}");
        let record = self.actions.record_handoff(
            &CmdHandOffInput {
                kind: verb,
                command: &cmd,
                target: "desired-state",
                consequence: reason.trim(),
                expected_result: &expected,
                verify_step: "Verify console_freeze metric matches requested state",
            },
            context,
        )?;
        Ok(record.handoff)
    }
}
