// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::Mutex;

use console_ops_application::actions::{
    ActionRecord, ActionStatus, ActionStore, CmdHandOffInput, new_action_id,
};
use console_ops_application::changes::{CanaryDecision, ChangesService};
use console_ops_application::domain::UtcTimestamp;
use console_ops_application::domain::incident::{
    IncidentEvent, IncidentRefusal, IncidentState, PersonalDataImpact, PublicDraftStage,
    PublicUpdateDraft,
};
use console_ops_application::domain::ladders::{EvidenceState, IncidentSeverity, PublicComponent};
use console_ops_application::incidents::{IncidentError, IncidentStore, IncidentsService};
use console_ops_application::obligations::{Context, Error as SpoolError, Operator};
use console_ops_application::promote::{
    FeedbackStore, FeedbackTriage, PromoteService, PromotionSignoff, PromotionStore,
};
use console_ops_application::snapshot::SourceKind;
use console_ops_application::sources_status::SourceSlot;
use console_ops_application::victoriametrics::{
    InstantSample, QUERY_CONTAINER_INFO, VictoriaMetricsSnapshot,
};
use time::macros::datetime;

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct MemActions(Mutex<Vec<ActionRecord>>);
impl ActionStore for MemActions {
    fn list_actions(&self) -> Result<Vec<ActionRecord>, SpoolError> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
    fn record_handoff(
        &self,
        input: &CmdHandOffInput<'_>,
        context: &Context,
    ) -> Result<ActionRecord, SpoolError> {
        let mut g = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let seq = g.len() as u64 + 1;
        let rec = ActionRecord {
            seq,
            hash: "h".into(),
            support_ref: context.support_ref.clone(),
            at: UtcTimestamp::new(context.at),
            operator: context.operator.person.clone(),
            status: ActionStatus::Pending,
            handoff: console_ops_application::domain::changes::CmdHandOff {
                action_id: new_action_id(seq),
                kind: input.kind.to_owned(),
                command: input.command.to_owned(),
                target: input.target.to_owned(),
                consequence: input.consequence.to_owned(),
                expected_result: input.expected_result.to_owned(),
                verify_step: input.verify_step.to_owned(),
                operator: context.operator.person.clone(),
                at: UtcTimestamp::new(context.at),
            },
        };
        g.push(rec.clone());
        Ok(rec)
    }
}

struct MemIncidents(Mutex<Vec<IncidentState>>);
impl IncidentStore for MemIncidents {
    fn list(&self) -> Result<Vec<IncidentState>, IncidentError> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
    fn get(&self, id: &str) -> Result<IncidentState, IncidentError> {
        self.list()?
            .into_iter()
            .find(|i| i.id == id)
            .ok_or(IncidentError::Domain(IncidentRefusal::NotFound))
    }
    fn declare(
        &self,
        event: IncidentEvent,
        context: &Context,
    ) -> Result<IncidentState, IncidentError> {
        let mut g = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let id = format!("INC-{:04}", g.len() + 1);
        let st = IncidentState::evolve(
            None,
            &id,
            &event,
            1,
            "h1",
            context.at,
            &context.operator.person,
            Some(0),
        )?;
        g.push(st.clone());
        Ok(st)
    }
    fn mutate(
        &self,
        id: &str,
        expected_seq: u64,
        event: IncidentEvent,
        context: &Context,
    ) -> Result<IncidentState, IncidentError> {
        let mut g = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let idx = g
            .iter()
            .position(|i| i.id == id)
            .ok_or(IncidentError::Domain(IncidentRefusal::NotFound))?;
        let next = IncidentState::evolve(
            Some(&g[idx]),
            id,
            &event,
            g[idx].head_seq + 1,
            "h2",
            context.at,
            &context.operator.person,
            Some(expected_seq),
        )?;
        g[idx] = next.clone();
        Ok(next)
    }
}

struct DummyPromotions;
impl PromotionStore for DummyPromotions {
    fn list_signoffs(&self) -> Result<Vec<PromotionSignoff>, SpoolError> {
        Ok(vec![])
    }
    fn record_signoff(
        &self,
        _digest: &str,
        _verdict: &str,
        _note: &str,
        _context: &Context,
    ) -> Result<PromotionSignoff, SpoolError> {
        Err(SpoolError::WriteFailed)
    }
}

struct DummyFeedback;
impl FeedbackStore for DummyFeedback {
    fn list_feedback(&self) -> Result<Vec<FeedbackTriage>, SpoolError> {
        Ok(vec![])
    }
    fn record_triage(
        &self,
        _feedback_id: &str,
        _digest: &str,
        _severity: &str,
        _disposition: &str,
        _note: &str,
        _context: &Context,
    ) -> Result<FeedbackTriage, SpoolError> {
        Err(SpoolError::WriteFailed)
    }
}

#[test]
fn incidents_changes_and_promote_services_produce_expected_views_and_cmds() -> TestResult {
    let now = datetime!(2026-11-20 00:00 UTC);
    let interval = NonZeroU64::new(60).ok_or("nonzero")?;
    let ctx = Context {
        at: now,
        operator: Operator {
            person: "op-1".into(),
            method: "access-jwt".into(),
        },
        support_ref: "sup-1".into(),
    };

    let actions = MemActions(Mutex::new(vec![]));
    let incidents = MemIncidents(Mutex::new(vec![]));
    let inc_svc = IncidentsService {
        incidents: &incidents,
        actions: &actions,
    };
    let inc = inc_svc
        .declare(
            IncidentEvent::Declared {
                title: "Outage".into(),
                sev: IncidentSeverity::Sev2,
                lead: None,
                affected_components: vec!["api".into()],
                personal_data_impact: PersonalDataImpact::No,
                intrusion: false,
                discovered_at: UtcTimestamp::new(now),
                next_public_update_at: None,
                public_incident_id: None,
            },
            &ctx,
        )
        .map_err(|e| format!("{e:?}"))?;
    let (_, cmd) = inc_svc
        .draft_public_update(
            &inc.id,
            inc.head_seq,
            PublicUpdateDraft {
                stage: PublicDraftStage::Component(PublicComponent::DegradedPerformance),
                components: vec!["api".into()],
                message_ko: "Investigating issue".into(),
                message_en: "Investigating".into(),
                rev: 1,
            },
            &ctx,
        )
        .map_err(|e| format!("{e:?}"))?;
    assert!(cmd.command.starts_with("scripts/tb status publish"));

    let mut vm_slot = SourceSlot::new(
        "victoriametrics",
        SourceKind::VictoriaMetrics,
        "vm".into(),
        interval,
    );
    vm_slot.begin_read(now);
    vm_slot.finish_ok(VictoriaMetricsSnapshot {
        series: BTreeMap::new(),
        targets: vec![],
    });

    let changes_svc = ChangesService {
        releases: None,
        host_state: None,
        actions: &actions,
    };
    let changes_view = changes_svc.build_view(&vm_slot, now, interval);
    assert_eq!(changes_view.dora5.n, 0);
    assert_eq!(
        changes_view.dora5.deployment_frequency.state(),
        EvidenceState::Unknown
    );
    assert!(
        changes_svc
            .request_canary(CanaryDecision::Hold, "Inspecting", &ctx)
            .is_ok()
    );
    assert!(
        changes_svc
            .request_freeze(true, "Incident freeze", &ctx)
            .is_ok()
    );

    let digest = format!("sha256:{}", "a".repeat(64));
    let promote_svc = PromoteService {
        releases: None,
        promotions: &DummyPromotions,
        feedback: &DummyFeedback,
        actions: &actions,
    };
    assert!(promote_svc.request_promote(&digest, "normal", &ctx).is_ok());

    struct AllGatesPass;
    impl console_ops_application::changes::ReleasesStore for AllGatesPass {
        fn list_releases(
            &self,
        ) -> Result<Vec<console_ops_application::changes::ReleaseArtifact>, String> {
            Ok(vec![])
        }
        fn get_gates(
            &self,
            d: &str,
        ) -> Result<Option<console_ops_application::domain::changes::GateStatement>, String>
        {
            let hex = d.strip_prefix("sha256:").unwrap_or(d);
            let raw = serde_json::json!({
                "_type": "https://in-toto.io/Statement/v1",
                "predicateType": "https://cosskorea.com/attestations/console-gates/v1",
                "subject": [{"digest": {"sha256": hex}}],
                "predicate": {
                    "inputs": {},
                    "gates": [
                        {"name": "code-gates", "result": "pass"},
                        {"name": "api-compat", "result": "pass"},
                        {"name": "sbom", "result": "pass"},
                        {"name": "scan", "result": "pass"},
                        {"name": "smoke", "result": "pass"}
                    ],
                    "runner": {"kind": "gha", "url": null},
                    "approver": null,
                    "bake": "normal"
                }
            });
            Ok(
                console_ops_application::domain::changes::parse_gate_statement(
                    &raw.to_string(),
                    Some(d),
                )
                .ok(),
            )
        }
    }
    let gates_store = AllGatesPass;
    let ready_svc = PromoteService {
        releases: Some(&gates_store),
        promotions: &DummyPromotions,
        feedback: &DummyFeedback,
        actions: &actions,
    };
    let mut promo_vm = SourceSlot::new(
        "victoriametrics",
        SourceKind::VictoriaMetrics,
        "vm".into(),
        interval,
    );
    promo_vm.begin_read(now);
    promo_vm.finish_ok(VictoriaMetricsSnapshot {
        series: BTreeMap::from([
            (
                console_ops_application::victoriametrics::QUERY_PREVIEW_DIGEST_INFO.to_owned(),
                vec![InstantSample {
                    metric: [("digest".into(), digest.clone())].into(),
                    timestamp_s: now.unix_timestamp() as f64,
                    value: 1.0,
                }],
            ),
            (
                console_ops_application::victoriametrics::QUERY_PREVIEW_RUNNING.to_owned(),
                vec![InstantSample {
                    metric: BTreeMap::new(),
                    timestamp_s: now.unix_timestamp() as f64,
                    value: 1.0,
                }],
            ),
        ]),
        targets: vec![],
    });
    let ready_view = ready_svc
        .build_view(&promo_vm, now)
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        ready_view.state.value(),
        Some(&console_ops_application::domain::ladders::Promotion::Ready),
        "0 signoffs with all 5 gates passing and no freeze/blocker must report Ready"
    );

    promo_vm.begin_read(now);
    promo_vm.finish_ok(VictoriaMetricsSnapshot {
        series: BTreeMap::from([
            (
                console_ops_application::victoriametrics::QUERY_PREVIEW_DIGEST_INFO.to_owned(),
                vec![InstantSample {
                    metric: [("digest".into(), digest.clone())].into(),
                    timestamp_s: now.unix_timestamp() as f64,
                    value: 1.0,
                }],
            ),
            (
                console_ops_application::victoriametrics::QUERY_PREVIEW_RUNNING.to_owned(),
                vec![InstantSample {
                    metric: BTreeMap::new(),
                    timestamp_s: now.unix_timestamp() as f64,
                    value: 1.0,
                }],
            ),
            (
                console_ops_application::victoriametrics::QUERY_FREEZE.to_owned(),
                vec![InstantSample {
                    metric: BTreeMap::new(),
                    timestamp_s: now.unix_timestamp() as f64,
                    value: 1.0,
                }],
            ),
        ]),
        targets: vec![],
    });
    let frozen_view = ready_svc
        .build_view(&promo_vm, now)
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        frozen_view.state.value(),
        Some(&console_ops_application::domain::ladders::Promotion::Blocked),
        "active QUERY_FREEZE must block promotion"
    );

    let running_digest = format!("sha256:{}", "d".repeat(64));
    vm_slot.begin_read(now);
    vm_slot.finish_ok(VictoriaMetricsSnapshot {
        series: BTreeMap::from([(
            QUERY_CONTAINER_INFO.to_owned(),
            vec![InstantSample {
                metric: [
                    ("service".into(), "api".into()),
                    ("digest".into(), running_digest.clone()),
                ]
                .into(),
                timestamp_s: now.unix_timestamp() as f64,
                value: 1.0,
            }],
        )]),
        targets: vec![],
    });
    let with_vm_digest = changes_svc.build_view(&vm_slot, now, interval);
    assert_eq!(with_vm_digest.releases.len(), 1);
    assert_eq!(with_vm_digest.releases[0].digest, running_digest);
    assert_eq!(with_vm_digest.releases[0].state, EvidenceState::Unknown);
    assert_eq!(
        with_vm_digest.releases[0].reason.as_deref(),
        Some("gate missing")
    );
    Ok(())
}
