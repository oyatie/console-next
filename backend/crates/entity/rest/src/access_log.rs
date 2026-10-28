// SPDX-License-Identifier: LicenseRef-Proprietary
//! Entity people have revision/sequence keys, not employee identities. Documents are immutable sets.
use console_entity_application::{
    LegalEntityView, WORKPLACE_PERSONAL_FIELDS, WorkplaceView, workplace_personal_field_is_present,
};
use console_kernel_core::{AuditCommandContext, AuditEvent, AuditOutcome};
use console_platform_authz::Principal;
use console_platform_db::with_audit;
use console_platform_request_context::audit_context::access_log::{
    AccessRecord, access_event_with_subject_refs,
};
use serde_json::json;

use crate::{EntityRestState, error::RestError};

pub(crate) fn subjects(entities: &[LegalEntityView]) -> Vec<String> {
    let mut subjects = Vec::new();
    for entity in entities {
        for state in entity.current.iter().chain(&entity.scheduled) {
            for (table, count) in [
                (
                    "legal_entity_representatives",
                    state.representatives.as_ref().map_or(0, Vec::len),
                ),
                (
                    "legal_entity_directors",
                    state.directors.as_ref().map_or(0, Vec::len),
                ),
            ] {
                for seq in 1..=count {
                    subjects.push(format!("{table}:{}:{}:{seq}", entity.id, state.version));
                }
            }
        }
        for registration in &entity.registrations {
            if let Some(state) = &registration.current {
                for seq in 1..=state.co_owners.as_ref().map_or(0, Vec::len) {
                    subjects.push(format!(
                        "business_registration_co_owners:{}:{}:{seq}",
                        registration.id, state.version
                    ));
                }
            }
        }
        subjects.extend(workplace_subjects(&entity.workplaces));
    }
    subjects.sort_unstable();
    subjects.dedup();
    subjects
}

pub(crate) fn workplace_subjects(workplaces: &[WorkplaceView]) -> Vec<String> {
    let mut subjects: Vec<_> = workplaces
        .iter()
        .filter_map(|w| {
            let state = w.current.as_ref()?;
            WORKPLACE_PERSONAL_FIELDS
                .iter()
                .any(|field| workplace_personal_field_is_present(*field, state))
                .then(|| format!("workplace_revisions:{}:{}", w.id, state.version))
        })
        .collect();
    subjects.sort_unstable();
    subjects.dedup();
    subjects
}

pub(crate) fn event(
    principal: &Principal,
    action: &'static str,
    target: String,
    subjects: &[String],
) -> Result<AuditEvent, RestError> {
    Ok(access_event_with_subject_refs(
        principal,
        AccessRecord {
            action,
            target_type: if action.starts_with("entity_document.") {
                "entity_document"
            } else if action.starts_with("business_registration.") {
                "business_registration"
            } else if action.starts_with("workplace.") {
                "workplace"
            } else {
                "legal_entity"
            },
            target_id: target,
            subject_ids: &[],
            reader_subject: None,
            details: json!({"subject_id_kind":"immutable_record_reference"}),
        },
        subjects,
    )?)
}

pub(crate) async fn record(s: &EntityRestState, event: AuditEvent) -> Result<(), RestError> {
    with_audit::<_, _, console_platform_db::DbError>(s.store.pool(), event, |_tx| {
        Box::pin(async { Ok(()) })
    })
    .await
    .map_err(console_entity_adapter_postgres::PgEntityError::from)?;
    Ok(())
}

/// A resolved caller's failed read logs no subjects, because none were returned.
pub(crate) async fn refused(
    s: &EntityRestState,
    h: &axum::http::HeaderMap,
    action: &'static str,
    id: uuid::Uuid,
    error: RestError,
) -> RestError {
    let Ok(principal) = crate::auth::principal(s, h).await else {
        return error;
    };
    let result = async {
        let mut access = event(&principal, action, id.to_string(), &[])?;
        access.after.get_or_insert_with(|| json!({}))["refusal_code"] = json!(error.0.code);
        let mut context = AuditCommandContext::for_actor(Some(principal.user_id));
        context.outcome = AuditOutcome::Denied;
        record(s, access.with_command_context(context)).await
    }
    .await;
    result.err().unwrap_or(error)
}
