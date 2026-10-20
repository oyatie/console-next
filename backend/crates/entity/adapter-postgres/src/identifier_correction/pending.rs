// SPDX-License-Identifier: LicenseRef-Proprietary
//! Persist and replay the pending receipt without applying the correction.
use super::*;
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
    attached: Option<AuditEvent>,
) -> Result<(CorrectionOutcome<T>, Vec<AuditEvent>), PgEntityError> {
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
        Some(json!({ "status": "PENDING", "requested_by": actor.user })),
    );
    let mut events: Vec<_> = attached.into_iter().collect();
    events.push(event);
    Ok((pending(tx, exception_id, input).await?, events))
}
