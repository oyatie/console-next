// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) struct MemActions(pub(super) Mutex<Vec<ActionRecord>>);
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

pub(super) struct DummyPromotions;
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

pub(super) struct DummyFeedback;
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

pub(super) struct AllGatesPass;
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

pub(super) struct SignedPromotions(pub(super) String);
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
