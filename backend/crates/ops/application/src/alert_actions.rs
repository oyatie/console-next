// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;

use console_ops_domain::alert_actions::{
    SilenceCreateInput, SilenceMatcherInput, SilenceValidationError, validate_alert_ack_note,
    validate_silence_create,
};
use console_ops_domain::ladders::{AlertState, Severity};
use console_ops_domain::{Observed, UtcTimestamp};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::SourceError;
use crate::SourceFuture;
use crate::obligations::{Context, Error as SpoolError};
pub use crate::silences_eval::resolve_silence_target_severity;
use crate::snapshot::{AlertGroupDetailView, AlertGroupsView, ChangeView};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertAckRecord {
    pub seq: u64,
    pub hash: String,
    pub support_ref: String,
    pub at: UtcTimestamp,
    pub operator: String,
    pub group_key: String,
    pub alertname: String,
    pub component: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SilenceAuditRecord {
    pub seq: u64,
    pub hash: String,
    pub support_ref: String,
    pub at: UtcTimestamp,
    pub operator: String,
    pub action: String,
    #[serde(default)]
    pub silence_id: Option<String>,
    #[serde(default)]
    pub group_key: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertmanagerSilencePost {
    pub matchers: Vec<SilenceMatcherInput>,
    pub starts_at: UtcTimestamp,
    pub ends_at: UtcTimestamp,
    pub created_by: String,
    pub comment: String,
}

pub trait AlertmanagerWriter: Send + Sync {
    fn create_silence(&self, req: &AlertmanagerSilencePost) -> SourceFuture<'_, String>;
    fn delete_silence(&self, id: &str) -> SourceFuture<'_, ()>;
}

pub trait AlertAckStore: Send + Sync {
    fn list_acks(&self) -> Result<Vec<AlertAckRecord>, SpoolError>;
    fn record_ack(
        &self,
        group_key: &str,
        alertname: &str,
        component: &str,
        note: Option<String>,
        context: &Context,
    ) -> Result<AlertAckRecord, SpoolError>;
}

pub trait SilenceAuditStore: Send + Sync {
    fn list_records(&self) -> Result<Vec<SilenceAuditRecord>, SpoolError>;
    fn record_event(
        &self,
        action: &str,
        silence_id: Option<&str>,
        group_key: Option<&str>,
        detail: Option<&str>,
        context: &Context,
    ) -> Result<SilenceAuditRecord, SpoolError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlertActionError {
    NotFound,
    InvalidAckNote,
    SilenceValidation(SilenceValidationError),
    Spool(SpoolError),
    Upstream(SourceError),
}

impl From<SilenceValidationError> for AlertActionError {
    fn from(value: SilenceValidationError) -> Self {
        Self::SilenceValidation(value)
    }
}

impl From<SpoolError> for AlertActionError {
    fn from(value: SpoolError) -> Self {
        Self::Spool(value)
    }
}

/// Alertmanager has applied the change even when recording its outcome needs recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedSilence {
    pub silence_id: String,
    pub audit_error: Option<SpoolError>,
}

pub struct AlertActionsService<'a> {
    pub ack_store: &'a dyn AlertAckStore,
    pub silence_store: &'a dyn SilenceAuditStore,
    pub am_writer: &'a dyn AlertmanagerWriter,
}

impl<'a> AlertActionsService<'a> {
    pub fn ack_group(
        &self,
        group: Option<&AlertGroupDetailView>,
        note: Option<&str>,
        context: &Context,
    ) -> Result<AlertAckRecord, AlertActionError> {
        let detail = group.ok_or(AlertActionError::NotFound)?;
        let clean_note =
            validate_alert_ack_note(note).map_err(|_| AlertActionError::InvalidAckNote)?;
        let component = detail
            .summary_group
            .component
            .value()
            .cloned()
            .unwrap_or_default();
        self.ack_store
            .record_ack(
                &detail.summary_group.key,
                &detail.summary_group.alertname,
                &component,
                clean_note,
                context,
            )
            .map_err(AlertActionError::Spool)
    }

    pub async fn create_silence(
        &self,
        input: &SilenceCreateInput,
        groups: &AlertGroupsView,
        context: &Context,
    ) -> Result<AppliedSilence, AlertActionError> {
        self.create_silence_with_details(input, groups, None, context)
            .await
    }

    pub async fn create_silence_with_details(
        &self,
        input: &SilenceCreateInput,
        groups: &AlertGroupsView,
        details: Option<&BTreeMap<String, AlertGroupDetailView>>,
        context: &Context,
    ) -> Result<AppliedSilence, AlertActionError> {
        validate_silence_create(input, Some(Severity::Ticket), context.at)?;
        let target_severity = resolve_silence_target_severity(input, groups, details)?;
        let validated = validate_silence_create(input, Some(target_severity), context.at)?;

        // Write silences spool FIRST before mutating Alertmanager.
        self.silence_store.record_event(
            "silence_requested",
            None,
            validated.group_key.as_deref(),
            Some(&validated.comment),
            context,
        )?;

        let post = AlertmanagerSilencePost {
            matchers: validated.matchers,
            starts_at: validated.starts_at,
            ends_at: validated.ends_at,
            created_by: context.operator.person.clone(),
            // The durable request and upstream silence can be matched even after a restart.
            comment: format!("{} [{}]", validated.comment, context.support_ref),
        };
        match self.am_writer.create_silence(&post).await {
            Ok(silence_id) => {
                let audit_error = self
                    .silence_store
                    .record_event(
                        "silence_created",
                        Some(&silence_id),
                        validated.group_key.as_deref(),
                        None,
                        context,
                    )
                    .err();
                Ok(AppliedSilence {
                    silence_id,
                    audit_error,
                })
            }
            Err(err) => {
                let _ = self.silence_store.record_event(
                    "silence_failed",
                    None,
                    validated.group_key.as_deref(),
                    Some(&err.to_string()),
                    context,
                );
                Err(AlertActionError::Upstream(err))
            }
        }
    }

    pub async fn delete_silence(
        &self,
        silence_id: &str,
        context: &Context,
    ) -> Result<AppliedSilence, AlertActionError> {
        let id = silence_id.trim();
        if id.is_empty() || id.contains(['/', '?', '#', ' ']) {
            return Err(AlertActionError::SilenceValidation(
                SilenceValidationError::Invalid("invalid silence id".to_owned()),
            ));
        }
        self.silence_store.record_event(
            "silence_expire_requested",
            Some(id),
            None,
            None,
            context,
        )?;
        match self.am_writer.delete_silence(id).await {
            Ok(()) => {
                let audit_error = self
                    .silence_store
                    .record_event("silence_expired", Some(id), None, None, context)
                    .err();
                Ok(AppliedSilence {
                    silence_id: id.to_owned(),
                    audit_error,
                })
            }
            Err(err) => {
                let _ = self.silence_store.record_event(
                    "silence_expire_failed",
                    Some(id),
                    None,
                    Some(&err.to_string()),
                    context,
                );
                Err(AlertActionError::Upstream(err))
            }
        }
    }
}

pub fn overlay_acks_and_changes(
    groups: &mut AlertGroupsView,
    details: &mut BTreeMap<String, AlertGroupDetailView>,
    acks: &[AlertAckRecord],
    recent_changes: &[ChangeView],
    now: OffsetDateTime,
    interval_s: NonZeroU64,
) {
    let mut first_acks: BTreeMap<&str, &AlertAckRecord> = BTreeMap::new();
    let mut seen_keys = BTreeSet::new();
    for ack in acks {
        if seen_keys.insert(ack.group_key.as_str()) {
            first_acks.insert(ack.group_key.as_str(), ack);
        }
    }

    for group in &mut groups.groups {
        if let Some(ack) = first_acks.get(group.key.as_str()) {
            let lead = Observed::current(
                ack.operator.clone(),
                None,
                "alerts".to_owned(),
                now,
                now,
                interval_s,
            );
            group.lead = Some(lead.clone());
            if group.state.value() == Some(&AlertState::Firing) {
                group.state = Observed::current(
                    AlertState::Acked,
                    None,
                    "alerts".to_owned(),
                    now,
                    now,
                    interval_s,
                );
            }
            if let Some(detail) = details.get_mut(&group.key) {
                detail.summary_group = group.clone();
            }
        }
    }

    let cutoff = now - Duration::hours(2);
    let filtered_changes: Vec<ChangeView> = recent_changes
        .iter()
        .filter(|c| c.at.value().is_some_and(|ts| **ts >= cutoff && **ts <= now))
        .cloned()
        .collect();
    if !filtered_changes.is_empty() {
        for detail in details.values_mut() {
            detail.changes = filtered_changes.clone();
        }
    }
}
