// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::Mutex;

use console_ops_application::actions::{
    ActionRecord, ActionStatus, ActionStore, CmdHandOffInput, new_action_id,
};
use console_ops_application::changes::{ReleaseArtifact, ReleasesStore};
use console_ops_application::domain::UtcTimestamp;
use console_ops_application::domain::changes::{GateStatement, parse_gate_statement};
use console_ops_application::domain::ladders::Promotion;
use console_ops_application::obligations::{Context, Error as SpoolError, Operator};
use console_ops_application::promote::{
    FeedbackStore, FeedbackTriage, PromoteService, PromotionSignoff, PromotionStore,
};
use console_ops_application::snapshot::SourceKind;
use console_ops_application::sources_status::SourceSlot;
use console_ops_application::victoriametrics::{
    InstantSample, QUERY_FREEZE, QUERY_PREVIEW_DIGEST_INFO, QUERY_PREVIEW_RUNNING,
    VictoriaMetricsSnapshot,
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

struct AllGatesPass;
impl ReleasesStore for AllGatesPass {
    fn list_releases(&self) -> Result<Vec<ReleaseArtifact>, String> {
        Ok(vec![])
    }
    fn get_gates(&self, d: &str) -> Result<Option<GateStatement>, String> {
        let hex = d.strip_prefix("sha256:").unwrap_or(d);
        let raw = serde_json::json!({
            "_type": "https://in-toto.io/Statement/v1",
            "predicateType": "https://cosskorea.com/attestations/console-gates/v1",
            "subject": [{"name":"registry.example/tenant/console-app","digest": {"sha256": hex}}],
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
        Ok(parse_gate_statement(&raw.to_string(), Some(d)).ok())
    }
}

struct SignedPromotions(String);
impl PromotionStore for SignedPromotions {
    fn list_signoffs(&self) -> Result<Vec<PromotionSignoff>, SpoolError> {
        Ok(vec![PromotionSignoff {
            seq: 1,
            hash: "h1".into(),
            support_ref: "sup-1".into(),
            at: UtcTimestamp::new(datetime!(2026-11-20 00:00 UTC)),
            operator: "op-1".into(),
            digest: self.0.clone(),
            verdict: "ready".into(),
            note: "reviewed".into(),
        }])
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

#[test]
fn promote_service_watches_without_signoffs_and_blocks_ready_on_freeze() -> TestResult {
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
    let digest = format!("sha256:{}", "a".repeat(64));

    let mut statement = AllGatesPass
        .get_gates(&digest)?
        .ok_or("missing statement")?;
    for invalid in [
        "-bad.example/repo",
        "registry.example/tool;extra",
        "registry.example/",
        "unqualified/repo",
    ] {
        statement.subject[0].name = Some(invalid.into());
        assert!(statement.release_image(&digest).is_none());
    }
    statement.subject[0].name = Some("registry.example/repo".into());
    statement.subject.push(statement.subject[0].clone());
    assert!(statement.release_image(&digest).is_none());
    let gates_store = AllGatesPass;
    let watching_svc = PromoteService {
        releases: Some(&gates_store),
        promotions: &DummyPromotions,
        feedback: &DummyFeedback,
        actions: &actions,
    };
    let signed = SignedPromotions(digest.clone());
    let ready_svc = PromoteService {
        releases: Some(&gates_store),
        promotions: &signed,
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
                QUERY_PREVIEW_DIGEST_INFO.to_owned(),
                vec![InstantSample {
                    metric: [("digest".into(), digest.clone())].into(),
                    timestamp_s: now.unix_timestamp() as f64,
                    value: 1.0,
                }],
            ),
            (
                QUERY_PREVIEW_RUNNING.to_owned(),
                vec![InstantSample {
                    metric: BTreeMap::new(),
                    timestamp_s: now.unix_timestamp() as f64,
                    value: 1.0,
                }],
            ),
        ]),
        targets: vec![],
    });
    assert!(
        ready_svc
            .build_view(&promo_vm, now)
            .map_err(|e| format!("{e:?}"))?
            .state
            .value()
            .is_none()
    );
    assert!(
        ready_svc
            .request_promote(&digest, "normal", &promo_vm, &ctx)
            .is_err()
    );
    let clear = InstantSample {
        metric: BTreeMap::new(),
        timestamp_s: now.unix_timestamp() as f64,
        value: 0.0,
    };
    for samples in [
        vec![],
        vec![InstantSample {
            timestamp_s: clear.timestamp_s - 121.0,
            ..clear.clone()
        }],
        vec![InstantSample {
            timestamp_s: clear.timestamp_s + 2.0,
            ..clear.clone()
        }],
        vec![InstantSample {
            value: f64::NAN,
            ..clear.clone()
        }],
    ] {
        promo_vm
            .current
            .as_mut()
            .ok_or("missing snapshot")?
            .series
            .insert(QUERY_FREEZE.to_owned(), samples);
        assert!(
            ready_svc
                .request_promote(&digest, "normal", &promo_vm, &ctx)
                .is_err()
        );
    }
    promo_vm
        .current
        .as_mut()
        .ok_or("missing snapshot")?
        .series
        .insert(QUERY_FREEZE.to_owned(), vec![clear]);
    assert!(
        watching_svc
            .request_promote(&digest, "normal", &promo_vm, &ctx)
            .is_err()
    );
    let other_digest = format!("sha256:{}", "b".repeat(64));
    assert!(
        ready_svc
            .request_promote(&other_digest, "normal", &promo_vm, &ctx)
            .is_err()
    );
    assert!(
        actions
            .list_actions()
            .map_err(|e| format!("{e:?}"))?
            .is_empty()
    );
    assert!(
        ready_svc
            .request_promote(&digest, "normal", &promo_vm, &ctx)
            .is_ok()
    );
    assert!(
        ready_svc
            .request_promote(&digest, "long", &promo_vm, &ctx)
            .is_err()
    );
    let recorded = actions.list_actions().map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        recorded[0].handoff.command,
        format!("APPROVER='op-1' scripts/tb release registry.example/tenant/console-app@{digest}")
    );
    let watching_view = watching_svc
        .build_view(&promo_vm, now)
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        watching_view.state.value(),
        Some(&Promotion::Watching),
        "0 signoffs with all 5 gates passing and no freeze/blocker must report Watching"
    );
    let ready_view = ready_svc
        .build_view(&promo_vm, now)
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        ready_view.state.value(),
        Some(&Promotion::Ready),
        "ready signoff with all 5 gates passing and no freeze/blocker must report Ready"
    );

    promo_vm.begin_read(now);
    promo_vm.finish_ok(VictoriaMetricsSnapshot {
        series: BTreeMap::from([
            (
                QUERY_PREVIEW_DIGEST_INFO.to_owned(),
                vec![InstantSample {
                    metric: [("digest".into(), digest.clone())].into(),
                    timestamp_s: now.unix_timestamp() as f64,
                    value: 1.0,
                }],
            ),
            (
                QUERY_PREVIEW_RUNNING.to_owned(),
                vec![InstantSample {
                    metric: BTreeMap::new(),
                    timestamp_s: now.unix_timestamp() as f64,
                    value: 1.0,
                }],
            ),
            (
                QUERY_FREEZE.to_owned(),
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
        Some(&Promotion::Blocked),
        "active QUERY_FREEZE must block promotion"
    );
    assert!(
        ready_svc
            .request_promote(&digest, "normal", &promo_vm, &ctx)
            .is_err()
    );
    assert_eq!(
        actions.list_actions().map_err(|e| format!("{e:?}"))?.len(),
        1
    );
    Ok(())
}
