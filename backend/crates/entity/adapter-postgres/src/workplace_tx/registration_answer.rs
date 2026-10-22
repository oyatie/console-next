// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{Admitted, PgEntityError, Tx, audit};
use console_entity_application::{Actor, WorkplaceReferenceResolver};
use console_entity_domain::{
    Refusal,
    workplace::WorkplaceInput,
    workplace_registration::{ResolvedReferenceCode, WorkplaceRegistrationAnswer},
};
use console_kernel_core::AuditEvent;
use serde_json::json;
use uuid::Uuid;
pub(crate) fn registration_answer(
    registration: Option<Uuid>,
    reason: Option<&str>,
) -> WorkplaceRegistrationAnswer {
    if registration.is_some() {
        WorkplaceRegistrationAnswer::Registered
    } else if reason.is_some() {
        WorkplaceRegistrationAnswer::NotRequired
    } else {
        WorkplaceRegistrationAnswer::Later
    }
}

pub(crate) fn answer_event(
    actor: &Actor,
    admitted: Admitted,
    workplace: Uuid,
    from: Option<WorkplaceRegistrationAnswer>,
    to: WorkplaceRegistrationAnswer,
) -> Result<AuditEvent, PgEntityError> {
    audit(
        actor,
        "workplace.registration_answer.changed",
        "workplace",
        workplace,
        admitted,
        json!({ "from": from.map(WorkplaceRegistrationAnswer::as_str), "to": to.as_str() }),
    )
}

pub(crate) fn observe_answer(answer: WorkplaceRegistrationAnswer) {
    metrics::counter!("workplace_registration_answer", "answer" => answer.as_str()).increment(1);
}

pub(super) async fn stored_reason(
    tx: &mut Tx<'_>,
    id: Uuid,
) -> Result<Option<ResolvedReferenceCode>, PgEntityError> {
    let row: (Option<String>, Option<String>, Option<String>, Option<String>, bool) = sqlx::query_as(
        "SELECT not_registered_reason_code, not_registered_reason_label, not_registered_reason_list_key, not_registered_reason_version, is_abstract FROM workplaces WHERE id = $1"
    ).bind(id).fetch_one(tx.as_mut()).await?;
    Ok(match row {
        (Some(code), Some(label), Some(list_key), Some(version), abstract_workplace) => {
            Some(ResolvedReferenceCode {
                code,
                label,
                list_key,
                version,
                abstract_workplace,
            })
        }
        _ => None,
    })
}

pub(super) fn resolved_reason(
    input: &WorkplaceInput,
    stored: Option<&ResolvedReferenceCode>,
    references: Option<WorkplaceReferenceResolver>,
) -> Result<Option<ResolvedReferenceCode>, PgEntityError> {
    if input.registration_id.is_some() {
        return Ok(None);
    }
    let Some(raw) = input
        .not_registered_reason
        .as_ref()
        .filter(|r| r.code.as_deref().is_some_and(|c| !c.trim().is_empty()))
    else {
        return Ok(None);
    };
    if let Some(stored) = stored.filter(|s| {
        raw.code.as_deref().map(str::trim) == Some(s.code.as_str())
            && raw.version.as_deref() == Some(s.version.as_str())
    }) {
        return Ok(Some(stored.clone()));
    }
    let resolve =
        references.ok_or_else(|| Refusal::field("not_registered_reason", "invalid_option"))?;
    Ok(Some(resolve(raw)?))
}
