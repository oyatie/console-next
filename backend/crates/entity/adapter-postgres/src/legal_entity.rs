//! 법인 writes: create, revise (full state, effective-dated), roles, void.

use console_entity_application::{
    Actor, EntityRoles, LegalEntityRevision, LegalEntityView, Saved, VoidRecord,
};
use console_entity_domain::Refusal;
use console_entity_domain::legal_entity::LegalEntityInput;
use console_kernel_core::WriteClass;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::legal_entity_tx::{create_entity_in_tx, revise_entity_in_tx, void_entity_in_tx};
use crate::org_units::OrgUnitSetupWritePort;
use crate::{PgEntityError, PgEntityStore, Tx, admit, audit, read};
use std::sync::Arc;

impl PgEntityStore {
    /// # Errors
    /// Domain refusals or database faults.
    pub async fn list_entities(
        &self,
        actor: &Actor,
        personal: bool,
    ) -> Result<Vec<LegalEntityView>, PgEntityError> {
        let granted = actor.scope.granted().map(<[Uuid]>::to_vec);
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move { read::entities(tx, None, granted.as_deref(), personal).await })
        })
        .await
    }

    /// # Errors
    /// `legal_entity_not_found`, or database faults.
    pub async fn get_entity(
        &self,
        actor: &Actor,
        id: Uuid,
        personal: bool,
    ) -> Result<LegalEntityView, PgEntityError> {
        let granted = actor.scope.granted().map(<[Uuid]>::to_vec);
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move { one(tx, id, granted.as_deref(), personal).await })
        })
        .await
    }

    /// Register a 법인 / 개인사업자 (SETUP: immediate; OPERATING: governed).
    ///
    /// # Errors
    /// Field issues, duplicate 법인등록번호, or database faults.
    pub async fn create_entity(
        &self,
        actor: &Actor,
        input: LegalEntityInput,
    ) -> Result<Saved<LegalEntityView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(
                    tx,
                    &actor,
                    "legal_entity.create",
                    serde_json::to_value(&input)?,
                )
                .await?
                {
                    return Ok((replay(tx, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let (id, warnings, event) =
                    create_entity_in_tx(tx, &actor, admitted, &input).await?;
                finish(
                    tx,
                    &actor,
                    &Outcome {
                        target: Some(id),
                        change_mode: Some(admitted.mode.as_str().into()),
                        count: None,
                    },
                )
                .await?;
                let record = one(tx, id, None, true).await?;
                Ok((
                    Saved {
                        record,
                        warnings,
                        change_mode: admitted.mode.as_str().into(),
                    },
                    vec![event],
                ))
            })
        })
        .await
    }

    /// A new revision with the full state. Confirms a migrated or vendor draft
    /// (clears `needs_confirmation`). A set 사업자 구분 or 법인등록번호 is not
    /// changed here: `use_identifier_correction` (MR-17); a missing one is filled.
    ///
    /// # Errors
    /// Field issues, `use_identifier_correction`, or database faults.
    pub async fn revise_entity(
        &self,
        actor: &Actor,
        id: Uuid,
        rev: LegalEntityRevision,
    ) -> Result<Saved<LegalEntityView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(
                    tx,
                    &actor,
                    "legal_entity.revise",
                    json!({ "id": id, "revision": rev }),
                )
                .await?
                {
                    return Ok((replay(tx, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let (warnings, event) = revise_entity_in_tx(tx, &actor, admitted, id, &rev).await?;
                finish(
                    tx,
                    &actor,
                    &Outcome {
                        target: Some(id),
                        change_mode: Some(admitted.mode.as_str().into()),
                        count: None,
                    },
                )
                .await?;
                let record = one(tx, id, None, true).await?;
                Ok((
                    Saved {
                        record,
                        warnings,
                        change_mode: admitted.mode.as_str().into(),
                    },
                    vec![event],
                ))
            })
        })
        .await
    }

    /// Set 대표 사업장 / 본점 사업장 (or 「본점은 사무실만 있음」).
    ///
    /// # Errors
    /// `workplace_of_other_entity`, field issues, or database faults.
    pub async fn set_entity_roles(
        &self,
        actor: &Actor,
        id: Uuid,
        roles: EntityRoles,
    ) -> Result<Saved<LegalEntityView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "legal_entity.set_roles", json!({ "id": id, "roles": roles })).await? {
                    return Ok((replay(tx, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                crate::workplace::lock_entity(tx, id).await?;
                if roles.head_office_has_no_workplace && roles.head_office_workplace_id.is_some() {
                    return Err(Refusal::field("head_office_has_no_workplace", "not_applicable").into());
                }
                for (field, wp) in [("primary_workplace_id", roles.primary_workplace_id), ("head_office_workplace_id", roles.head_office_workplace_id)] {
                    let Some(wp) = wp else { continue };
                    let ok: bool = sqlx::query_scalar(
                        "SELECT EXISTS (SELECT 1 FROM workplaces WHERE id = $1 AND legal_entity_id = $2 AND voided_at IS NULL)",
                    )
                    .bind(wp)
                    .bind(id)
                    .fetch_one(tx.as_mut())
                    .await?;
                    if !ok {
                        return Err(Refusal::field(field, "workplace_of_other_entity").into());
                    }
                }
                if let Some(wp) = roles.primary_workplace_id { crate::name_evidence::primary_workplace(tx, id, wp).await?; }
                sqlx::query(
                    "UPDATE legal_entities SET primary_workplace_id = COALESCE($2, primary_workplace_id), \
                       head_office_workplace_id = $3, head_office_has_no_workplace = $4 WHERE id = $1",
                )
                .bind(id)
                .bind(roles.primary_workplace_id)
                .bind(roles.head_office_workplace_id)
                .bind(roles.head_office_has_no_workplace)
                .execute(tx.as_mut())
                .await?;
                let event = audit(&actor, "legal_entity.set_roles", "legal_entity", id, admitted, json!({
                    "primary_workplace_id": roles.primary_workplace_id,
                    "head_office_workplace_id": roles.head_office_workplace_id,
                    "head_office_has_no_workplace": roles.head_office_has_no_workplace,
                }))?;
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = one(tx, id, None, true).await?;
                Ok((Saved { record, warnings: Vec::new(), change_mode: admitted.mode.as_str().into() }, vec![event]))
            })
        })
        .await
    }

    /// Undo a mistaken 법인 during setup, with its own 사업장 and 등록. Refused
    /// when people or org units point at it (the refusal says which).
    ///
    /// # Errors
    /// `phase_not_setup`, `record_in_use`, or database faults.
    pub async fn void_entity(
        &self,
        actor: &Actor,
        id: Uuid,
        cmd: VoidRecord,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<(), PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if claim(
                    tx,
                    &actor,
                    "legal_entity.void",
                    json!({ "id": id, "void": cmd }),
                )
                .await?
                .is_some()
                {
                    return Ok(((), vec![]));
                }
                let admitted = crate::record_end::admit_void(tx, "legal_entity_id", id).await?;
                let reason = void_reason(cmd.reason_code.as_deref())?;
                let event =
                    void_entity_in_tx(tx, &actor, admitted, id, &reason, port.as_ref()).await?;
                finish(tx, &actor, &Outcome::default()).await?;
                Ok(((), vec![event]))
            })
        })
        .await
    }
}

pub(crate) fn void_reason(raw: Option<&str>) -> Result<String, PgEntityError> {
    let mut is = console_entity_domain::Issues::default();
    let reason = console_entity_domain::revision_reason::person_reason(&mut is, raw);
    Ok(is.finish_opt(|| reason)?.as_str().to_owned())
}

/// One 법인 within `granted` (`None`: the whole tenant, as every writer
/// reading back its own record).
pub(crate) async fn one(
    tx: &mut Tx<'_>,
    id: Uuid,
    granted: Option<&[Uuid]>,
    personal: bool,
) -> Result<LegalEntityView, PgEntityError> {
    read::entities(tx, Some(id), granted, personal)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| Refusal::not_found("legal_entity_not_found").into())
}

/// A replayed 법인 command: the record as it is now, saved as it was then.
pub(crate) async fn replay(
    tx: &mut Tx<'_>,
    done: Outcome,
) -> Result<Saved<LegalEntityView>, PgEntityError> {
    let id = done
        .target
        .ok_or_else(|| Refusal::not_found("legal_entity_not_found"))?;
    Ok(Saved {
        record: one(tx, id, None, true).await?,
        warnings: Vec::new(),
        change_mode: done.change_mode.unwrap_or_default(),
    })
}
