// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_domain::Observed;
use console_ops_domain::UtcTimestamp;
use console_ops_domain::changes::{CmdHandOff, is_valid_sha256_digest};
use console_ops_domain::ladders::Promotion;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::actions::{ActionStore, CmdHandOffInput};
use crate::changes::ReleasesStore;
use crate::obligations::{Context, Error as SpoolError};
use crate::sources_status::SourceSlot;
use crate::victoriametrics::{
    QUERY_PREVIEW_DIGEST_INFO, QUERY_PREVIEW_RUNNING, VictoriaMetricsSnapshot,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromotionSignoff {
    pub seq: u64,
    pub hash: String,
    pub support_ref: String,
    pub at: UtcTimestamp,
    pub operator: String,
    pub digest: String,
    pub verdict: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedbackTriage {
    pub seq: u64,
    pub hash: String,
    pub support_ref: String,
    pub at: UtcTimestamp,
    pub operator: String,
    pub feedback_id: String,
    pub digest: String,
    pub severity: String,
    pub disposition: String,
    pub note: String,
}

pub trait PromotionStore: Send + Sync {
    fn list_signoffs(&self) -> Result<Vec<PromotionSignoff>, SpoolError>;
    fn record_signoff(
        &self,
        digest: &str,
        verdict: &str,
        note: &str,
        context: &Context,
    ) -> Result<PromotionSignoff, SpoolError>;
}

pub trait FeedbackStore: Send + Sync {
    fn list_feedback(&self) -> Result<Vec<FeedbackTriage>, SpoolError>;
    fn record_triage(
        &self,
        feedback_id: &str,
        digest: &str,
        severity: &str,
        disposition: &str,
        note: &str,
        context: &Context,
    ) -> Result<FeedbackTriage, SpoolError>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PromoteView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub candidate_digest: Observed<String>,
    pub state: Observed<Promotion>,
    pub signoffs: Vec<PromotionSignoff>,
    pub feedback: Vec<FeedbackTriage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromoteError {
    InvalidInput(String),
    Spool(SpoolError),
}

impl From<SpoolError> for PromoteError {
    fn from(value: SpoolError) -> Self {
        Self::Spool(value)
    }
}

pub struct PromoteService<'a> {
    pub releases: Option<&'a dyn ReleasesStore>,
    pub promotions: &'a dyn PromotionStore,
    pub feedback: &'a dyn FeedbackStore,
    pub actions: &'a dyn ActionStore,
}

impl<'a> PromoteService<'a> {
    pub fn build_view(
        &self,
        vm: &SourceSlot<VictoriaMetricsSnapshot>,
        now: OffsetDateTime,
    ) -> Result<PromoteView, PromoteError> {
        let signoffs = self.promotions.list_signoffs()?;
        let feedback = self.feedback.list_feedback()?;
        let preview_digest = vm.current.as_ref().and_then(|snap| {
            snap.series
                .get(QUERY_PREVIEW_DIGEST_INFO)
                .and_then(|v| v.first())
                .and_then(|s| s.metric.get("digest"))
                .cloned()
        });
        let preview_running = vm.current.as_ref().is_some_and(|snap| {
            snap.series
                .get(QUERY_PREVIEW_RUNNING)
                .is_some_and(|v| v.iter().any(|s| s.value > 0.0))
        });

        let has_open_blocker = feedback
            .iter()
            .any(|f| matches!(f.severity.as_str(), "P0" | "P1") && f.disposition == "open");
        let has_signoff = preview_digest.as_deref().is_some_and(|d| {
            signoffs
                .iter()
                .any(|s| s.digest == d && s.verdict == "ready")
        });
        let gates_ok = preview_digest.as_deref().is_some_and(|d| {
            self.releases
                .and_then(|r| r.get_gates(d).ok().flatten())
                .is_some()
        });

        let state_val = if !preview_running || preview_digest.is_none() {
            None
        } else if has_open_blocker || !gates_ok {
            Some(Promotion::Blocked)
        } else if has_signoff {
            Some(Promotion::Ready)
        } else {
            Some(Promotion::Watching)
        };

        Ok(PromoteView {
            evaluated_at: now,
            candidate_digest: vm.observe(preview_digest, None, now),
            state: vm.observe(state_val, None, now),
            signoffs,
            feedback,
        })
    }

    pub fn signoff(
        &self,
        digest: &str,
        verdict: &str,
        note: &str,
        context: &Context,
    ) -> Result<PromotionSignoff, PromoteError> {
        let d = digest.trim();
        let v = verdict.trim();
        if !is_valid_sha256_digest(d) || !matches!(v, "ready" | "blocked") || note.trim().is_empty()
        {
            return Err(PromoteError::InvalidInput(
                "signoff requires valid sha256 digest, verdict (ready|blocked), and note"
                    .to_owned(),
            ));
        }
        Ok(self.promotions.record_signoff(d, v, note.trim(), context)?)
    }

    pub fn triage_feedback(
        &self,
        feedback_id: &str,
        digest: &str,
        severity: &str,
        disposition: &str,
        note: &str,
        context: &Context,
    ) -> Result<FeedbackTriage, PromoteError> {
        let d = digest.trim();
        if feedback_id.trim().is_empty()
            || !is_valid_sha256_digest(d)
            || !matches!(severity, "P0" | "P1" | "P2")
            || !matches!(disposition, "open" | "triaged" | "resolved" | "wontfix")
            || note.trim().is_empty()
        {
            return Err(PromoteError::InvalidInput(
                "feedback triage requires non-empty id, sha256 digest, severity, disposition, and note"
                    .to_owned(),
            ));
        }
        Ok(self.feedback.record_triage(
            feedback_id.trim(),
            d,
            severity,
            disposition,
            note.trim(),
            context,
        )?)
    }

    pub fn request_promote(
        &self,
        digest: &str,
        bake: &str,
        context: &Context,
    ) -> Result<CmdHandOff, PromoteError> {
        let d = digest.trim();
        if !is_valid_sha256_digest(d) || !matches!(bake, "normal" | "long") {
            return Err(PromoteError::InvalidInput(
                "promote request requires valid sha256 digest and bake (normal|long)".to_owned(),
            ));
        }
        let cmd = format!(
            "APPROVER={} BAKE={} scripts/tb release {d}",
            context.operator.person, bake
        );
        let consequence = format!("Promotes {d} with {bake} bake");
        let record = self.actions.record_handoff(
            &CmdHandOffInput {
                kind: "promote",
                command: &cmd,
                target: d,
                consequence: &consequence,
                expected_result: "Rollout initiates toward canary/active",
                verify_step: "Verify /changes shows rollout progressing",
            },
            context,
        )?;
        Ok(record.handoff)
    }
}
