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
use console_ops_application::victoriametrics::VictoriaMetricsSnapshot;
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
        digest: &str,
        verdict: &str,
        note: &str,
        context: &Context,
    ) -> Result<PromotionSignoff, SpoolError> {
        Ok(PromotionSignoff {
            seq: 1,
            hash: "h".into(),
            support_ref: context.support_ref.clone(),
            at: UtcTimestamp::new(context.at),
            operator: context.operator.person.clone(),
            digest: digest.into(),
            verdict: verdict.into(),
            note: note.into(),
        })
    }
}

struct DummyFeedback;
impl FeedbackStore for DummyFeedback {
    fn list_feedback(&self) -> Result<Vec<FeedbackTriage>, SpoolError> {
        Ok(vec![])
    }
    fn record_triage(
        &self,
        feedback_id: &str,
        digest: &str,
        severity: &str,
        disposition: &str,
        note: &str,
        context: &Context,
    ) -> Result<FeedbackTriage, SpoolError> {
        Ok(FeedbackTriage {
            seq: 1,
            hash: "h".into(),
            support_ref: context.support_ref.clone(),
            at: UtcTimestamp::new(context.at),
            operator: context.operator.person.clone(),
            feedback_id: feedback_id.into(),
            digest: digest.into(),
            severity: severity.into(),
            disposition: disposition.into(),
            note: note.into(),
        })
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
    Ok(())
}
