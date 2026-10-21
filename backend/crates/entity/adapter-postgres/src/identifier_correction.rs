//! MR-17: correct a locked identifier (사업자 구분, 법인등록번호,
//! 사업자등록번호) with evidence. One audited transaction: the evidence is
//! attached, a ledger row records before/after, then the head changes.
//! SETUP applies at once; after 운영 시작 the governed exception for exactly
//! this correction is consumed first (the 0263 lock trigger checks the ledger
//! row of this transaction).

use console_entity_application::{Actor, LegalEntityView, RegistrationView, Saved};
use console_entity_domain::Refusal;
use console_entity_domain::codes::BizKind;
use console_entity_domain::correction::{
    IdentifierCorrection, IdentifierCorrectionInput, IdentifierField, validate_correction,
};
use console_kernel_core::{AuditEvent, ChangeMode, ErrorKind, TenantPhase};
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::Row;
use std::sync::Arc;
use uuid::Uuid;

use crate::command::{Outcome, claim, command_id, finish};
use crate::documents::attach_in_tx;
use crate::governed::{CorrectionCover, CorrectionSubject, GovernedCorrectionPort, OpsCover};
use crate::{Admitted, PgEntityError, PgEntityStore, Tx, audit, read_phase};

pub type Gate = Option<Arc<dyn GovernedCorrectionPort>>;

/// The tenant ops account's cover for a correction (decisions #26 item d):
/// `Some` only when the verified caller is the ops account.
type ByOps<'a> = Option<Option<&'a serde_json::Value>>;

fn by_ops(input: &IdentifierCorrectionInput) -> ByOps<'_> {
    input.by_ops.then_some(input.step_up.as_ref())
}

/// SETUP: immediate. OPERATING: only by consuming the correction's exception,
/// which the tenant ops account may record itself after a step-up.
async fn admit_correction(
    tx: &mut Tx<'_>,
    c: &IdentifierCorrection,
    subject: CorrectionSubject,
    gate: Gate,
    actor: &Actor,
    ops: ByOps<'_>,
) -> Result<(Admitted, Option<Uuid>), PgEntityError> {
    let phase = read_phase(tx, true).await?;
    if phase == TenantPhase::Setup {
        return Ok((
            Admitted {
                phase,
                mode: ChangeMode::Setup,
            },
            None,
        ));
    }
    // fail closed until INTEG wires the governance consumer.
    let unwired = || -> PgEntityError {
        Refusal::conflict(
            "identifier_correction_unavailable",
            "governed identifier corrections are not wired on this server",
        )
        .with_remedy("contact_support")
        .into()
    };
    let payload = serde_json::to_value(c.governed_payload())?;
    let exception = match (c.exception_id, ops) {
        (Some(exception), _) => exception,
        (None, None) => {
            return Err(Refusal::conflict(
                "identifier_correction_needs_exception",
                "after 운영 시작 an identifier correction needs an approved governed exception",
            )
            .with_remedy("request_governed_exception")
            .into());
        }
        (None, Some(None)) => {
            return Err(Refusal::new(
                ErrorKind::Forbidden,
                "passkey_step_up_required",
                "the ops account correcting an identifier after 운영 시작 needs a passkey step-up",
            )
            .with_remedy("passkey_step_up")
            .into());
        }
        (None, Some(Some(step_up))) => {
            let line = c.ops_step_up_line();
            let port = gate.as_ref().ok_or_else(unwired)?;
            port.cover_as_ops(
                tx,
                OpsCover {
                    org: actor.org,
                    actor: *actor.user.as_uuid(),
                    subject,
                    payload: &payload,
                    reason_code: c.reason.as_str(),
                    step_up_line: &line,
                    step_up,
                },
            )
            .await?
        }
    };
    let Some(gate) = gate else {
        return Err(unwired());
    };
    let cover = gate
        .consume(tx.as_mut(), exception, subject, &payload)
        .await?;
    let mode = match cover {
        CorrectionCover::SecondPerson => ChangeMode::Governed,
        CorrectionCover::SoleHolder => ChangeMode::SoleHolder,
    };
    Ok((Admitted { phase, mode }, Some(exception)))
}

struct LedgerRow<'a> {
    entity: Uuid,
    registration: Option<Uuid>,
    field: IdentifierField,
    old: Option<&'a str>,
    new: Option<&'a str>,
}

async fn ledger(
    tx: &mut Tx<'_>,
    actor: &Actor,
    c: &IdentifierCorrection,
    admitted: Admitted,
    exception: Option<Uuid>,
    row: LedgerRow<'_>,
) -> Result<(), PgEntityError> {
    sqlx::query(
        "INSERT INTO entity_identifier_corrections (org_id, legal_entity_id, registration_id, field, old_value, \
           new_value, reason_code, document_id, exception_id, change_mode, actor_id, command_id) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, \
           $11::uuid)",
    )
    .bind(row.entity)
    .bind(row.registration)
    .bind(row.field.as_str())
    .bind(row.old)
    .bind(row.new)
    .bind(c.reason.as_str())
    .bind(c.document_id)
    .bind(exception)
    .bind(admitted.mode.as_str())
    .bind(*actor.user.as_uuid())
    .bind(command_id(actor)?)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

fn unchanged() -> PgEntityError {
    Refusal::field("value", "identifier_unchanged").into()
}

impl PgEntityStore {
    /// Correct 사업자 구분 or 법인등록번호 of a 법인. Leaving CORPORATION
    /// clears the 법인등록번호 in the same command (it no longer applies).
    ///
    /// # Errors
    /// Field issues, `identifier_unchanged`, `identifier_correction_needs_exception`,
    /// `identifier_correction_unavailable`, the exception's own refusals, or
    /// database faults.
    pub async fn correct_entity_identifier(
        &self,
        actor: &Actor,
        id: Uuid,
        input: IdentifierCorrectionInput,
        gate: Gate,
    ) -> Result<Saved<LegalEntityView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let request = json!({ "id": id, "correction": input });
                if let Some(done) = claim(tx, &actor, "legal_entity.correct_identifier", request).await? {
                    let record = crate::legal_entity::one(tx, id, None, true).await?;
                    return Ok((Saved { record, warnings: vec![], change_mode: done.change_mode.unwrap_or_default() }, vec![]));
                }
                let c = validate_correction(&input, false)?;
                let head = sqlx::query("SELECT biz_kind, crn, voided_at IS NOT NULL AS voided FROM legal_entities WHERE id = $1 FOR UPDATE")
                    .bind(id)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| Refusal::not_found("legal_entity_not_found"))?;
                if head.try_get::<bool, _>("voided")? {
                    return Err(Refusal::conflict("legal_entity_voided", "the legal entity was voided").into());
                }
                let (kind, crn): (Option<String>, Option<String>) = (head.try_get("biz_kind")?, head.try_get("crn")?);
                let corporation = |k: Option<&str>| k == Some(BizKind::Corporation.as_str());
                let mut rows = Vec::new();
                match c.field {
                    IdentifierField::BizKind => {
                        if kind.as_deref() == Some(c.value.as_str()) {
                            return Err(unchanged());
                        }
                        rows.push((IdentifierField::BizKind, kind.as_deref(), Some(c.value.as_str())));
                        if crn.is_some() && !corporation(Some(&c.value)) {
                            rows.push((IdentifierField::Crn, crn.as_deref(), None));
                        }
                    }
                    IdentifierField::Crn => {
                        if !corporation(kind.as_deref()) {
                            return Err(Refusal::field("field", "not_applicable").into());
                        }
                        if crn.as_deref() == Some(c.value.as_str()) {
                            return Err(unchanged());
                        }
                        rows.push((IdentifierField::Crn, crn.as_deref(), Some(c.value.as_str())));
                    }
                    IdentifierField::Brn => return Err(Refusal::field("field", "not_applicable").into()),
                }
                let new_kind = if c.field == IdentifierField::BizKind { Some(c.value.clone()) } else { kind.clone() };
                crate::name_evidence::correct_classification(tx, id, new_kind.as_deref().and_then(BizKind::parse), None).await?;
                let (admitted, exception) = admit_correction(tx, &c, CorrectionSubject::LegalEntity(id), gate, &actor, by_ops(&input)).await?;
                let (_, attached) = attach_in_tx(tx, &actor, c.document_id, id, None).await?;
                for (field, old, new) in &rows {
                    let row = LedgerRow { entity: id, registration: None, field: *field, old: *old, new: *new };
                    ledger(tx, &actor, &c, admitted, exception, row).await?;
                }
                let new_crn = rows.iter().find(|r| r.0 == IdentifierField::Crn).map_or(crn.clone(), |r| r.2.map(str::to_owned));
                sqlx::query("UPDATE legal_entities SET biz_kind = $2, crn = $3 WHERE id = $1")
                    .bind(id)
                    .bind(&new_kind)
                    .bind(&new_crn)
                    .execute(tx.as_mut())
                    .await?;
                let mut events: Vec<AuditEvent> = attached.into_iter().collect();
                events.push(audit(&actor, "legal_entity.correct_identifier", "legal_entity", id, admitted, json!({
                    "field": c.field.as_str(), "reason_code": c.reason.as_str(), "document_id": c.document_id,
                    "exception_id": exception, "ops_break_glass": input.by_ops && input.exception_id.is_none() && exception.is_some(), "cleared_crn": rows.len() > 1,
                }))?);
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = crate::legal_entity::one(tx, id, None, true).await?;
                Ok((Saved { record, warnings: vec![], change_mode: admitted.mode.as_str().into() }, events))
            })
        })
        .await
    }

    /// Correct the 사업자등록번호 of a 사업자등록.
    /// Errors: as entity correction, plus `registration_not_found`.
    pub async fn correct_registration_number(
        &self,
        actor: &Actor,
        id: Uuid,
        input: IdentifierCorrectionInput,
        gate: Gate,
    ) -> Result<Saved<RegistrationView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let request = json!({ "id": id, "correction": input });
                let replayed = claim(tx, &actor, "business_registration.correct_identifier", request).await?;
                let head = sqlx::query("SELECT legal_entity_id, brn, voided_at IS NOT NULL AS voided FROM business_registrations WHERE id = $1 FOR UPDATE")
                    .bind(id)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| Refusal::not_found("registration_not_found"))?;
                let entity: Uuid = head.try_get("legal_entity_id")?;
                if let Some(done) = replayed {
                    let record = crate::registration::one(tx, entity, id).await?;
                    return Ok((Saved { record, warnings: vec![], change_mode: done.change_mode.unwrap_or_default() }, vec![]));
                }
                if head.try_get::<bool, _>("voided")? {
                    return Err(Refusal::conflict("registration_voided", "the registration was voided").into());
                }
                let c = validate_correction(&input, true)?;
                let old: Option<String> = head.try_get("brn")?;
                if old.as_deref() == Some(c.value.as_str()) {
                    return Err(unchanged());
                }
                let kind: Option<String> = sqlx::query_scalar("SELECT biz_kind FROM legal_entities WHERE id = $1 FOR UPDATE").bind(entity).fetch_one(tx.as_mut()).await?;
                crate::name_evidence::correct_classification(tx, entity, kind.as_deref().and_then(BizKind::parse), Some((id, &c.value))).await?;
                let (admitted, exception) =
                    admit_correction(tx, &c, CorrectionSubject::BusinessRegistration(id), gate, &actor, by_ops(&input)).await?;
                let (_, attached) = attach_in_tx(tx, &actor, c.document_id, entity, Some(id)).await?;
                // A check of the old number never vouches for the new one (lane corrections #10).
                let row = LedgerRow { entity, registration: Some(id), field: IdentifierField::Brn, old: old.as_deref(), new: Some(&c.value) };
                ledger(tx, &actor, &c, admitted, exception, row).await?;
                sqlx::query("UPDATE business_registrations SET brn = $2, brn_pending_reason = NULL, verification_tier = 'NONE', \
                     unverified_reason = 'NOT_CHECKED' WHERE id = $1")
                    .bind(id)
                    .bind(&c.value)
                    .execute(tx.as_mut())
                    .await?;
                let mut events: Vec<AuditEvent> = attached.into_iter().collect();
                events.push(audit(&actor, "business_registration.correct_identifier", "business_registration", id, admitted, json!({
                    "field": "brn", "reason_code": c.reason.as_str(), "document_id": c.document_id, "exception_id": exception, "ops_break_glass": input.by_ops && input.exception_id.is_none() && exception.is_some(),
                }))?);
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = crate::registration::one(tx, entity, id).await?;
                Ok((Saved { record, warnings: vec![], change_mode: admitted.mode.as_str().into() }, events))
            })
        })
        .await
    }
}
