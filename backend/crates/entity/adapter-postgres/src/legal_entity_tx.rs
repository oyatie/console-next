//! 법인 writes inside the caller's transaction: the one-by-one create,
//! revise and void (`legal_entity.rs`) and the bulk batch (MR-29) share them.

use console_entity_application::{Actor, LegalEntityRevision};
use console_entity_domain::codes::VatUnitMode;
use console_entity_domain::legal_entity::{LegalEntityInput, validate_legal_entity};
use console_entity_domain::{Refusal, Warning};
use console_kernel_core::AuditEvent;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::legal_entity_revision::insert_revision;
use crate::org_units::OrgUnitSetupWritePort;
use crate::revision_copy::{RevisionAt, append_renamed_registrations};
use crate::site_unit::{dissolve_sites, ensure_unused};
use crate::{Admitted, PgEntityError, RevisionMeta, Tx, audit, today_kst};

/// Register a 법인 inside the caller's transaction, admitted as `admitted`
/// (the one-by-one create and the bulk batch share it).
pub(crate) async fn create_entity_in_tx(
    tx: &mut Tx<'_>,
    actor: &Actor,
    admitted: Admitted,
    input: &LegalEntityInput,
) -> Result<(Uuid, Vec<Warning>, AuditEvent), PgEntityError> {
    let today = today_kst(tx).await?;
    let (draft, warnings) = validate_legal_entity(input, today)?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO legal_entities (org_id, biz_kind, crn, created_change_mode, created_by, founding) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(draft.biz_kind.as_str())
    .bind(draft.crn.as_ref().map(|c| c.as_str().to_owned()))
    .bind(admitted.mode.as_str())
    .bind(*actor.user.as_uuid())
    .bind(draft.founding)
    .fetch_one(tx.as_mut())
    .await?;
    let vat = draft.declared_vat_unit_mode.map(|m| (m, "DECLARED"));
    // INTEG-3: the first record starts at 설립일 when it is known, else at the
    // 개업연월일 of the certificate typed with it (company-21), else today.
    let effective_from = draft.incorporated_on.or(draft.opened_on).unwrap_or(today);
    let meta = RevisionMeta {
        version: 1,
        effective_from,
        reason_code: console_entity_domain::SystemReason::Create.into(),
        admitted,
        actor,
        payload: serde_json::to_value(&draft)?,
    };
    insert_revision(tx, id, &draft, vat, &meta).await?;
    let event = audit(
        actor,
        "legal_entity.create",
        "legal_entity",
        id,
        admitted,
        json!({ "biz_kind": draft.biz_kind.as_str(), "name": draft.name }),
    )?;
    Ok((id, warnings, event))
}

/// Append a full-state revision of 법인 `id` inside the caller's transaction.
pub(crate) async fn revise_entity_in_tx(
    tx: &mut Tx<'_>,
    actor: &Actor,
    admitted: Admitted,
    id: Uuid,
    rev: &LegalEntityRevision,
) -> Result<(Vec<Warning>, AuditEvent), PgEntityError> {
    let env = crate::revision_envelope(rev)?;
    let (effective_from, reason) = (env.effective_from, env.reason);
    let head = sqlx::query(
        "SELECT h.biz_kind, h.crn, h.founding, h.voided_at IS NOT NULL AS voided, h.closed_on IS NOT NULL AS closed, \
                (SELECT COALESCE(max(version), 0) FROM legal_entity_revisions r WHERE r.legal_entity_id = h.id) AS version, \
                (SELECT r.name FROM legal_entity_revisions r WHERE r.legal_entity_id = h.id \
                  ORDER BY r.effective_from DESC, r.version DESC LIMIT 1) AS name, \
                (SELECT r.vat_unit_mode || '|' || r.vat_unit_mode_basis FROM legal_entity_revisions r \
                  WHERE r.legal_entity_id = h.id AND r.vat_unit_mode IS NOT NULL \
                  ORDER BY r.effective_from DESC, r.version DESC LIMIT 1) AS vat \
         FROM legal_entities h WHERE h.id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| Refusal::not_found("legal_entity_not_found"))?;
    if head.try_get::<bool, _>("voided")? {
        return Err(Refusal::conflict("legal_entity_voided", "the legal entity was voided").into());
    }
    if head.try_get::<bool, _>("closed")? {
        return Err(
            Refusal::conflict("legal_entity_not_open", "the legal entity is closed").into(),
        );
    }
    crate::ensure_version(env.expected_version, head.try_get("version")?)?;
    let today = today_kst(tx).await?;
    // 설립 중 is the record's, never the client's: it only ever ends (0308).
    let input = LegalEntityInput {
        founding: Some(head.try_get("founding")?),
        opened_on: None,
        ..rev.input.clone()
    };
    let (draft, warnings) = validate_legal_entity(&input, today)?;
    let old_kind: Option<String> = head.try_get("biz_kind")?;
    let old_crn: Option<String> = head.try_get("crn")?;
    let new_crn = draft.crn.as_ref().map(|c| c.as_str().to_owned());
    // MR-17: a set identifier changes only by a correction (evidence + ledger).
    for (field, old, new) in [
        (
            "biz_kind",
            old_kind.as_deref(),
            Some(draft.biz_kind.as_str()),
        ),
        ("crn", old_crn.as_deref(), new_crn.as_deref()),
    ] {
        if old.is_some() && old != new {
            return Err(Refusal::field(field, "use_identifier_correction")
                .with_remedy("request_identifier_correction")
                .into());
        }
    }
    sqlx::query("UPDATE legal_entities SET biz_kind = $2, crn = $3, founding = $4, needs_confirmation = false WHERE id = $1")
        .bind(id)
        .bind(draft.biz_kind.as_str())
        .bind(&new_crn)
        .bind(draft.founding)
        .execute(tx.as_mut())
        .await?;
    let previous_vat: Option<String> = head.try_get("vat")?;
    let vat = match draft.declared_vat_unit_mode {
        Some(mode) => Some((mode, "DECLARED")),
        None => previous_vat.as_deref().and_then(|v| {
            let (mode, basis) = v.split_once('|')?;
            Some((VatUnitMode::parse(mode)?, static_basis(basis)))
        }),
    };
    let version: i32 = head.try_get::<i32, _>("version")? + 1;
    let meta = RevisionMeta {
        version,
        effective_from,
        reason_code: reason.clone().into(),
        admitted,
        actor,
        payload: serde_json::to_value(&draft)?,
    };
    insert_revision(tx, id, &draft, vat, &meta).await?;
    if head.try_get::<Option<String>, _>("name")?.as_deref() != Some(draft.name.as_str()) {
        let at = RevisionAt {
            admitted,
            actor: actor.user,
            command: crate::command::command_id(actor)?,
        };
        append_renamed_registrations(tx, id, &draft.name, effective_from, at).await?;
    }
    let event = audit(
        actor,
        "legal_entity.revise",
        "legal_entity",
        id,
        admitted,
        json!({
            "version": version, "effective_from": effective_from.to_string(), "reason_code": reason,
        }),
    )?;
    let event =
        crate::history::seal_changed_fields(tx, event, crate::history::Record::Entity, version)
            .await?;
    Ok((warnings, event))
}

/// Void 법인 `id` (setup undo) inside the caller's transaction.
pub(crate) async fn void_entity_in_tx(
    tx: &mut Tx<'_>,
    actor: &Actor,
    admitted: Admitted,
    id: Uuid,
    reason: &str,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<AuditEvent, PgEntityError> {
    crate::workplace::lock_entity(tx, id).await?;
    ensure_unused(tx, "legal_entity_id", id).await?;
    let today = today_kst(tx).await?;
    dissolve_sites(tx, actor, "legal_entity_id", id, today, port).await?;
    sqlx::query("UPDATE business_registrations SET voided_at = now(), void_reason_code = $2 WHERE legal_entity_id = $1 AND voided_at IS NULL")
        .bind(id).bind(reason).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE workplaces SET voided_at = now(), void_reason_code = $2 WHERE legal_entity_id = $1 AND voided_at IS NULL")
        .bind(id).bind(reason).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE legal_entities SET voided_at = now(), void_reason_code = $2 WHERE id = $1")
        .bind(id)
        .bind(reason)
        .execute(tx.as_mut())
        .await?;
    let event = audit(
        actor,
        "legal_entity.void",
        "legal_entity",
        id,
        admitted,
        json!({ "reason_code": reason }),
    )?;
    Ok(event)
}

fn static_basis(raw: &str) -> &'static str {
    match raw {
        "SINGLE_REGISTRATION" => "SINGLE_REGISTRATION",
        "CERTIFICATE_UNIT_TAXATION" => "CERTIFICATE_UNIT_TAXATION",
        _ => "DECLARED",
    }
}
