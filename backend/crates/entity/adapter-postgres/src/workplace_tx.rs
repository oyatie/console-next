//! 사업장 writes inside the caller's transaction: the one-by-one create and
//! revise (`workplace.rs`) and the bulk batch (MR-29) share them.

use console_entity_application::{Actor, CreateWorkplace, WorkplaceRevision};
use console_entity_domain::Refusal;
use console_entity_domain::workplace::{WorkplaceContext, validate_workplace};
use console_kernel_core::AuditEvent;
use serde_json::json;
use uuid::Uuid;

use crate::org_units::OrgUnitSetupWritePort;
use crate::site_unit::{dissolve_sites, ensure_unused, rename_site, workplace_unit};
use crate::workplace::{lock_entity, lock_workplace, registration_facts, set_roles_on_create};
use crate::workplace_branch::default_branch;
use crate::workplace_kind::usable_kind;
use crate::workplace_revision::{insert_insurance, insert_revision};
use crate::{Admitted, PgEntityError, RevisionMeta, Tx, audit, today_kst};

/// Create a 사업장 under `entity` inside the caller's transaction (the
/// one-by-one create and the bulk batch share it).
pub(crate) async fn create_workplace_in_tx(
    tx: &mut Tx<'_>,
    actor: &Actor,
    admitted: Admitted,
    entity: Uuid,
    cmd: &CreateWorkplace,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<(Uuid, AuditEvent), PgEntityError> {
    let facts = lock_entity(tx, entity).await?;
    let today = today_kst(tx).await?;
    let (of_other, reg_address) =
        registration_facts(tx, entity, cmd.input.registration_id, None).await?;
    let ctx = WorkplaceContext {
        biz_kind: facts.biz_kind,
        registration_is_unit_taxation_of_other: of_other,
        creating: true,
    };
    let draft = validate_workplace(&cmd.input, ctx, today)?;
    let kind = usable_kind(tx, cmd.kind_code.as_deref(), None).await?;
    let branch =
        default_branch(tx, entity, &facts.name, &draft.name, cmd.default_branch_id).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO workplaces (org_id, legal_entity_id, registration_id, sub_serial, default_branch_id, \
           created_change_mode, created_by, kind_code, not_registered_reason_code, not_registered_reason_label, not_registered_reason_version, is_abstract) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id",
    )
    .bind(entity)
    .bind(draft.registration_id)
    .bind(draft.sub_serial.as_ref().map(|s| s.as_str().to_owned()))
    .bind(branch)
    .bind(admitted.mode.as_str())
    .bind(*actor.user.as_uuid())
    .bind(&kind)
    .bind(draft.not_registered_reason.as_ref().map(|r| r.code.as_str()))
    .bind(draft.not_registered_reason.as_ref().map(|r| r.label.as_str()))
    .bind(draft.not_registered_reason.as_ref().map(|r| r.version.as_str()))
    .bind(draft.is_abstract)
    .fetch_one(tx.as_mut())
    .await?;
    // INTEG-3: the first record starts at 개설일.
    let meta = RevisionMeta {
        version: 1,
        effective_from: draft.opened_on,
        reason_code: console_entity_domain::SystemReason::Create.into(),
        admitted,
        actor,
        payload: serde_json::to_value(&draft)?,
    };
    insert_revision(tx, id, &draft, reg_address, &meta).await?;
    for insurance in &draft.insurance {
        insert_insurance(tx, id, insurance, &meta).await?;
    }
    set_roles_on_create(
        tx,
        entity,
        id,
        cmd.is_primary,
        cmd.is_head_office,
        draft.registration_id,
        of_other,
    )
    .await?;
    // decisions #14.1: its own org-tree unit, so people can be placed here with no 부서.
    let site = workplace_unit(tx, actor, id, today, admitted, port).await?;
    let event = audit(
        actor,
        "workplace.create",
        "workplace",
        id,
        admitted,
        json!({ "legal_entity_id": entity, "name": draft.name, "default_branch_id": branch, "org_unit_id": site, "kind_code": kind }),
    )?;
    Ok((id, event))
}

/// Append a full-state revision of 사업장 `id` inside the caller's
/// transaction; returns its 법인.
pub(crate) async fn revise_workplace_in_tx(
    tx: &mut Tx<'_>,
    actor: &Actor,
    admitted: Admitted,
    id: Uuid,
    rev: WorkplaceRevision,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<(Uuid, AuditEvent), PgEntityError> {
    let env = crate::revision_envelope(&rev)?;
    let (effective_from, reason) = (env.effective_from, env.reason);
    let (entity, registration, version) = lock_workplace(tx, id).await?;
    crate::ensure_version(env.expected_version, version)?;
    let facts = lock_entity(tx, entity).await?;
    let today = today_kst(tx).await?;
    if rev.input.registration_id.is_some() && rev.input.registration_id != registration {
        return Err(Refusal::field("registration_id", "use_registration_change").into());
    }
    let mut input = rev.input;
    input.registration_id = registration;
    let (of_other, reg_address) = registration_facts(tx, entity, registration, Some(id)).await?;
    let ctx = WorkplaceContext {
        biz_kind: facts.biz_kind,
        registration_is_unit_taxation_of_other: of_other,
        creating: false,
    };
    let draft = validate_workplace(&input, ctx, today)?;
    // MR-18: the 종사업장 일련번호 moves with its registration link, as a dated change.
    let serial: Option<String> =
        sqlx::query_scalar("SELECT sub_serial FROM workplaces WHERE id = $1")
            .bind(id)
            .fetch_one(tx.as_mut())
            .await?;
    if draft.sub_serial.as_ref().map(|s| s.as_str()) != serial.as_deref() {
        return Err(Refusal::field("sub_serial", "use_registration_change").into());
    }
    let meta = RevisionMeta {
        version: version + 1,
        effective_from,
        reason_code: reason.clone().into(),
        admitted,
        actor,
        payload: serde_json::to_value(&draft)?,
    };
    insert_revision(tx, id, &draft, reg_address, &meta).await?;
    if effective_from <= today {
        rename_site(tx, actor, id, &draft.name, today, port).await?;
    }
    // MR-14: 폐업 closes the 사업장 (once it is empty); another status reopens it.
    crate::closure::apply_workplace_status(
        tx,
        actor,
        id,
        entity,
        draft.status,
        draft.status_since,
        today,
        admitted,
        port,
    )
    .await?;
    sqlx::query(
        "UPDATE workplaces SET needs_confirmation = false, \
           not_registered_reason_code = $2, not_registered_reason_label = $3, \
           not_registered_reason_version = $4, is_abstract = $5 \
         WHERE id = $1",
    )
    .bind(id)
    .bind(
        draft
            .not_registered_reason
            .as_ref()
            .map(|r| r.code.as_str()),
    )
    .bind(
        draft
            .not_registered_reason
            .as_ref()
            .map(|r| r.label.as_str()),
    )
    .bind(
        draft
            .not_registered_reason
            .as_ref()
            .map(|r| r.version.as_str()),
    )
    .bind(draft.is_abstract)
    .execute(tx.as_mut())
    .await?;
    let event = audit(
        actor,
        "workplace.revise",
        "workplace",
        id,
        admitted,
        json!({ "version": version + 1, "effective_from": effective_from.to_string(), "reason_code": reason }),
    )?;
    let event = crate::history::seal_changed_fields(
        tx,
        event,
        crate::history::Record::Workplace,
        version + 1,
    )
    .await?;
    Ok((entity, event))
}

/// Void 사업장 `id` (setup undo) inside the caller's transaction.
pub(crate) async fn void_workplace_in_tx(
    tx: &mut Tx<'_>,
    actor: &Actor,
    admitted: Admitted,
    id: Uuid,
    reason: &str,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<AuditEvent, PgEntityError> {
    let (entity, _, _) = crate::workplace::lock_workplace(tx, id).await?;
    ensure_unused(tx, "workplace_id", id).await?;
    let today = crate::today_kst(tx).await?;
    dissolve_sites(tx, actor, "workplace_id", id, today, port).await?;
    sqlx::query("UPDATE workplaces SET voided_at = now(), void_reason_code = $2 WHERE id = $1")
        .bind(id)
        .bind(reason)
        .execute(tx.as_mut())
        .await?;
    // Roles pointing at it move to nothing (the rail then asks again).
    sqlx::query(
        "UPDATE legal_entities SET \
           primary_workplace_id = CASE WHEN primary_workplace_id = $2 THEN NULL ELSE primary_workplace_id END, \
           head_office_workplace_id = CASE WHEN head_office_workplace_id = $2 THEN NULL ELSE head_office_workplace_id END \
         WHERE id = $1",
    )
    .bind(entity).bind(id).execute(tx.as_mut()).await?;
    sqlx::query("UPDATE business_registrations SET holder_workplace_id = NULL WHERE holder_workplace_id = $1")
        .bind(id).execute(tx.as_mut()).await?;
    let event = audit(
        actor,
        "workplace.void",
        "workplace",
        id,
        admitted,
        json!({ "reason_code": reason }),
    )?;
    Ok(event)
}
