//! 사업장 writes (with their default branch and 4대보험 rows) and views.

use console_entity_application::{Actor, CreateWorkplace, Saved, WorkplaceRevision, WorkplaceView};
use console_entity_domain::codes::BizKind;
use console_entity_domain::{Refusal, Warning};
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::org_units::OrgUnitSetupWritePort;
use crate::workplace_tx::{create_workplace_in_tx, revise_workplace_in_tx};
use crate::{PgEntityError, PgEntityStore, Tx, admit, today_kst};
use std::sync::Arc;

pub(crate) struct EntityFacts {
    pub biz_kind: Option<BizKind>,
    pub name: String,
}

pub(crate) async fn lock_entity(tx: &mut Tx<'_>, id: Uuid) -> Result<EntityFacts, PgEntityError> {
    let row = sqlx::query(
        "SELECT h.biz_kind, h.voided_at IS NOT NULL AS voided, h.closed_on, \
                r.name AS label \
         FROM legal_entities h LEFT JOIN LATERAL (SELECT name FROM legal_entity_revisions x \
              WHERE x.legal_entity_id = h.id ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) r ON true \
         WHERE h.id = $1 FOR UPDATE OF h",
    )
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| Refusal::not_found("legal_entity_not_found"))?;
    if row.try_get::<bool, _>("voided")?
        || row.try_get::<Option<time::Date>, _>("closed_on")?.is_some()
    {
        return Err(Refusal::conflict(
            "legal_entity_not_open",
            "the legal entity is voided or closed",
        )
        .into());
    }
    let kind: Option<String> = row.try_get("biz_kind")?;
    Ok(EntityFacts {
        biz_kind: kind.as_deref().and_then(BizKind::parse),
        name: row.try_get("label")?,
    })
}

/// The registration a workplace points at: same entity, open, and whether it
/// is a 사업자단위과세 registration held by another 사업장.
pub(crate) async fn registration_facts(
    tx: &mut Tx<'_>,
    entity: Uuid,
    registration: Option<Uuid>,
    this: Option<Uuid>,
) -> Result<(bool, Option<Uuid>), PgEntityError> {
    let Some(id) = registration else {
        return Ok((false, None));
    };
    let row = sqlx::query(
        "SELECT h.legal_entity_id, h.holder_workplace_id, r.business_address_id, COALESCE(r.unit_taxation, false) AS unit \
         FROM business_registrations h LEFT JOIN LATERAL (SELECT * FROM business_registration_revisions x \
              WHERE x.registration_id = h.id ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) r ON true \
         WHERE h.id = $1 AND h.voided_at IS NULL AND h.closed_on IS NULL",
    )
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| Refusal::field("registration_id", "registration_not_found"))?;
    if row.try_get::<Uuid, _>("legal_entity_id")? != entity {
        return Err(Refusal::field("registration_id", "registration_of_other_entity").into());
    }
    let holder: Option<Uuid> = row.try_get("holder_workplace_id")?;
    let unit: bool = row.try_get("unit")?;
    let of_other = unit && holder.is_some() && holder != this;
    Ok((of_other, row.try_get("business_address_id")?))
}

impl PgEntityStore {
    /// Create a 사업장 under `entity` (SETUP: immediate; OPERATING: governed),
    /// with its own SITE org unit (decisions #14.1).
    ///
    /// # Errors
    /// Domain refusals (field issues, entity not open) or database faults.
    pub async fn create_workplace(
        &self,
        actor: &Actor,
        entity: Uuid,
        cmd: CreateWorkplace,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<Saved<WorkplaceView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(
                    tx,
                    &actor,
                    "workplace.create",
                    json!({ "entity": entity, "input": cmd }),
                )
                .await?
                {
                    return Ok((replay(tx, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let (id, event) =
                    create_workplace_in_tx(tx, &actor, admitted, entity, &cmd, port.as_ref())
                        .await?;
                let today = today_kst(tx).await?;
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
                let record = one_view(tx, entity, id, today).await?;
                let saved = Saved {
                    record,
                    warnings: Vec::<Warning>::new(),
                    change_mode: admitted.mode.as_str().into(),
                };
                Ok((saved, vec![event]))
            })
        })
        .await
    }

    /// A new effective-dated revision of a 사업장 (full state).
    ///
    /// # Errors
    /// Domain refusals or database faults.
    pub async fn revise_workplace(
        &self,
        actor: &Actor,
        id: Uuid,
        rev: WorkplaceRevision,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<Saved<WorkplaceView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(
                    tx,
                    &actor,
                    "workplace.revise",
                    json!({ "id": id, "revision": rev }),
                )
                .await?
                {
                    return Ok((replay(tx, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let (entity, event) =
                    revise_workplace_in_tx(tx, &actor, admitted, id, rev, port.as_ref()).await?;
                let today = today_kst(tx).await?;
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
                let record = one_view(tx, entity, id, today).await?;
                Ok((
                    Saved {
                        record,
                        warnings: Vec::new(),
                        change_mode: admitted.mode.as_str().into(),
                    },
                    vec![event],
                ))
            })
        })
        .await
    }
}

pub(crate) async fn lock_workplace(
    tx: &mut Tx<'_>,
    id: Uuid,
) -> Result<(Uuid, Option<Uuid>, i32), PgEntityError> {
    let row = sqlx::query(
        "SELECT w.legal_entity_id, w.registration_id, w.voided_at IS NOT NULL AS voided, \
                (SELECT COALESCE(max(version), 0) FROM workplace_revisions r WHERE r.workplace_id = w.id) AS version \
         FROM workplaces w WHERE w.id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| Refusal::not_found("workplace_not_found"))?;
    if row.try_get::<bool, _>("voided")? {
        return Err(Refusal::conflict("workplace_voided", "the workplace was voided").into());
    }
    Ok((
        row.try_get("legal_entity_id")?,
        row.try_get("registration_id")?,
        row.try_get("version")?,
    ))
}

/// First 사업장 ⇒ 대표 사업장 (a fact: it is the only one). A certificate's own
/// 사업장 becomes the registration's holder when the registration has none.
pub(crate) async fn set_roles_on_create(
    tx: &mut Tx<'_>,
    entity: Uuid,
    workplace: Uuid,
    is_primary: Option<bool>,
    is_head_office: Option<bool>,
    registration: Option<Uuid>,
    of_other: bool,
) -> Result<(), PgEntityError> {
    let primary: bool =
        sqlx::query_scalar("SELECT primary_workplace_id IS NULL FROM legal_entities WHERE id = $1")
            .bind(entity)
            .fetch_one(tx.as_mut())
            .await?;
    if primary || is_primary == Some(true) {
        crate::name_evidence::primary_registration(tx, entity, registration).await?;
    }
    sqlx::query(
        "UPDATE legal_entities SET \
           primary_workplace_id = CASE WHEN $3 OR primary_workplace_id IS NULL THEN $2 ELSE primary_workplace_id END, \
           head_office_workplace_id = CASE WHEN $4 THEN $2 ELSE head_office_workplace_id END, \
           head_office_has_no_workplace = CASE WHEN $4 THEN false ELSE head_office_has_no_workplace END \
         WHERE id = $1",
    )
    .bind(entity)
    .bind(workplace)
    .bind(is_primary == Some(true))
    .bind(is_head_office == Some(true))
    .execute(tx.as_mut())
    .await?;
    if let (Some(reg), false) = (registration, of_other) {
        sqlx::query("UPDATE business_registrations SET holder_workplace_id = $2 WHERE id = $1 AND holder_workplace_id IS NULL")
            .bind(reg)
            .bind(workplace)
            .execute(tx.as_mut())
            .await?;
    }
    Ok(())
}

/// A replayed 사업장 command: the record as it is now.
async fn replay(tx: &mut Tx<'_>, done: Outcome) -> Result<Saved<WorkplaceView>, PgEntityError> {
    let id = done
        .target
        .ok_or_else(|| Refusal::not_found("workplace_not_found"))?;
    let entity: Uuid = sqlx::query_scalar("SELECT legal_entity_id FROM workplaces WHERE id = $1")
        .bind(id)
        .fetch_one(tx.as_mut())
        .await?;
    let today = today_kst(tx).await?;
    let record = one_view(tx, entity, id, today).await?;
    Ok(Saved {
        record,
        warnings: Vec::new(),
        change_mode: done.change_mode.unwrap_or_default(),
    })
}

/// One 사업장 as its writer sees it (personal fields included).
pub(crate) async fn one_view(
    tx: &mut Tx<'_>,
    entity: Uuid,
    id: Uuid,
    _today: time::Date,
) -> Result<WorkplaceView, PgEntityError> {
    crate::read::entities(tx, Some(entity), None, true)
        .await?
        .into_iter()
        .flat_map(|e| e.workplaces)
        .find(|w| w.id == id)
        .ok_or_else(|| Refusal::not_found("workplace_not_found").into())
}

pub(crate) use crate::workplace_views::views;
