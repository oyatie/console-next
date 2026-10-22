// SPDX-License-Identifier: LicenseRef-Proprietary
//! Persist and replay the pending receipt without applying the correction.
use super::*;

pub(super) async fn validate_evidence(
    tx: &mut Tx<'_>,
    id: Uuid,
    entity: Uuid,
    registration: Option<Uuid>,
) -> Result<(), PgEntityError> {
    let doc = match crate::documents::one(tx, id, true).await {
        Err(PgEntityError::Refused(r)) if r.code == "document_not_found" => {
            return Err(Refusal::field("document_id", "document_not_found").into());
        }
        other => other?,
    };
    let registration = registration
        .filter(|_| doc.kind == console_entity_domain::document::DocumentKind::BizRegCert);
    if doc.attached_elsewhere(entity, registration) {
        return Err(Refusal::field("document_id", "document_attached_elsewhere").into());
    }
    Ok(())
}

pub(super) async fn pending<T>(
    tx: &mut Tx<'_>,
    exception_id: Uuid,
    input: &IdentifierCorrectionInput,
) -> Result<CorrectionOutcome<T>, PgEntityError> {
    let c = validate_correction(input, input.field.as_deref() == Some("brn"))?;
    let payload_hash =
        sqlx::query_scalar("SELECT governed_exception_fingerprint($1, ARRAY[]::daterange[])")
            .bind(serde_json::to_value(c.governed_payload())?)
            .fetch_one(tx.as_mut())
            .await?;
    Ok(CorrectionOutcome::Pending {
        exception_id,
        payload_hash,
    })
}

pub(super) async fn save_pending<T>(
    tx: &mut Tx<'_>,
    actor: &Actor,
    exception_id: Uuid,
    input: &IdentifierCorrectionInput,
) -> Result<(CorrectionOutcome<T>, Vec<AuditEvent>), PgEntityError> {
    let c = validate_correction(input, input.field.as_deref() == Some("brn"))?;
    let mut proposal = serde_json::to_value(c.governed_payload())?;
    proposal["reason_code"] = json!(c.reason.as_str());
    finish(
        tx,
        actor,
        &Outcome {
            target: Some(exception_id),
            change_mode: Some("PENDING".into()),
            count: None,
        },
    )
    .await?;
    let event = AuditEvent::new(
        Some(actor.user),
        console_kernel_core::AuditAction::new("exception.request")?,
        "governed_exception",
        exception_id.to_string(),
        actor.trace.clone(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(actor.org)
    .with_snapshots(
        None,
        Some(json!({ "status": "PENDING", "requested_by": actor.user, "proposal": proposal })),
    );
    Ok((pending(tx, exception_id, input).await?, vec![event]))
}
