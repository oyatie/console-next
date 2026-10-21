//! 사업장 kind (decisions #18): the tenant's code list and the kind of one
//! 사업장. A label only, so every write is direct in both phases and audited
//! (onboarding-and-migration §7.2); the phase is still admitted, so the audit
//! row says SETUP or GOVERNED like every other 사업장 write.

use console_entity_application::{
    Actor, CreateWorkplaceKind, Saved, SetWorkplaceKind, UpdateWorkplaceKind, WorkplaceKindView,
    WorkplaceView,
};
use console_entity_domain::Refusal;
use console_entity_domain::workplace_kind::{PLATFORM_KINDS, code_shape, is_platform, label};
use console_kernel_core::WriteClass;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::workplace::{lock_workplace, one_view};
use crate::{PgEntityError, PgEntityStore, Tx, admit, audit, today_kst};

/// Every kind: the platform defaults in their order (with the tenant's
/// override, if any), then the tenant's own kinds in the order added.
async fn all(tx: &mut Tx<'_>) -> Result<Vec<WorkplaceKindView>, PgEntityError> {
    let rows =
        sqlx::query("SELECT code, label, active FROM workplace_kinds ORDER BY created_at, code")
            .fetch_all(tx.as_mut())
            .await?;
    let mut tenant = Vec::new();
    let mut overrides = std::collections::HashMap::new();
    for r in rows {
        let view = WorkplaceKindView {
            code: r.try_get("code")?,
            label: r.try_get("label")?,
            platform: false,
            active: r.try_get("active")?,
        };
        if is_platform(&view.code) {
            overrides.insert(view.code.clone(), view);
        } else {
            tenant.push(view);
        }
    }
    let mut out: Vec<WorkplaceKindView> = PLATFORM_KINDS
        .iter()
        .map(|code| {
            let found = overrides.remove(*code);
            WorkplaceKindView {
                code: (*code).to_owned(),
                label: found.as_ref().and_then(|o| o.label.clone()),
                platform: true,
                active: found.is_none_or(|o| o.active),
            }
        })
        .collect();
    out.extend(tenant);
    Ok(out)
}

async fn one(tx: &mut Tx<'_>, code: &str) -> Result<WorkplaceKindView, PgEntityError> {
    all(tx)
        .await?
        .into_iter()
        .find(|k| k.code == code)
        .ok_or_else(|| Refusal::not_found("workplace_kind_not_found").into())
}

/// The kind a 사업장 may be given: `None` (미지정), or an active kind of the
/// list. `current` (the kind it already has) stays valid even if deactivated.
pub(crate) async fn usable_kind(
    tx: &mut Tx<'_>,
    raw: Option<&str>,
    current: Option<&str>,
) -> Result<Option<String>, PgEntityError> {
    let Some(code) = code_shape(raw)? else {
        return Ok(None);
    };
    if current == Some(code.as_str()) {
        return Ok(Some(code));
    }
    let active: Option<bool> =
        sqlx::query_scalar("SELECT active FROM workplace_kinds WHERE code = $1")
            .bind(&code)
            .fetch_optional(tx.as_mut())
            .await?;
    match (is_platform(&code), active) {
        (true, None | Some(true)) | (false, Some(true)) => Ok(Some(code)),
        (_, Some(false)) => Err(Refusal::field("kind_code", "inactive_choice").into()),
        (false, None) => Err(Refusal::field("kind_code", "invalid_choice").into()),
    }
}

impl PgEntityStore {
    /// # Errors
    /// Database faults.
    pub async fn list_workplace_kinds(
        &self,
        actor: &Actor,
    ) -> Result<Vec<WorkplaceKindView>, PgEntityError> {
        with_org_conn(&self.pool, actor.org, |tx| {
            Box::pin(async move { all(tx).await })
        })
        .await
    }

    /// Add a tenant kind (server-generated code).
    ///
    /// # Errors
    /// `label: required | too_long | label_taken`, or database faults.
    pub async fn create_workplace_kind(
        &self,
        actor: &Actor,
        cmd: CreateWorkplaceKind,
    ) -> Result<WorkplaceKindView, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "workplace_kind.create", json!(cmd)).await? {
                    let id = done.target.ok_or_else(|| Refusal::not_found("workplace_kind_not_found"))?;
                    return Ok((one(tx, &id.to_string()).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let name = label(cmd.label.as_deref())?;
                let id = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO workplace_kinds (org_id, code, label, created_by) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3)",
                )
                .bind(id.to_string())
                .bind(&name)
                .bind(*actor.user.as_uuid())
                .execute(tx.as_mut())
                .await?;
                let event = audit(&actor, "workplace_kind.create", "workplace_kind", id, admitted, json!({ "code": id, "label": name }))?;
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                Ok((one(tx, &id.to_string()).await?, vec![event]))
            })
        })
        .await
    }

    /// Relabel and/or (de)activate one kind; a platform default gets (or
    /// updates) the tenant's override row.
    ///
    /// # Errors
    /// `workplace_kind_not_found`, `label: required | too_long | label_taken`.
    pub async fn update_workplace_kind(
        &self,
        actor: &Actor,
        code: String,
        cmd: UpdateWorkplaceKind,
    ) -> Result<WorkplaceKindView, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if claim(tx, &actor, "workplace_kind.update", json!({ "code": code, "input": cmd })).await?.is_some() {
                    return Ok((one(tx, &code).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let current = one(tx, &code).await?;
                let next_label = match &cmd.label {
                    None => current.label.clone(),
                    Some(None) if current.platform => None,
                    Some(raw) => Some(label(raw.as_deref())?),
                };
                let active = cmd.active.unwrap_or(current.active);
                sqlx::query(
                    "INSERT INTO workplace_kinds (org_id, code, label, active, created_by) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4) \
                     ON CONFLICT (org_id, code) DO UPDATE SET label = EXCLUDED.label, active = EXCLUDED.active, updated_at = now()",
                )
                .bind(&code)
                .bind(&next_label)
                .bind(active)
                .bind(*actor.user.as_uuid())
                .execute(tx.as_mut())
                .await?;
                // the audit target id is the tenant code's UUID; a
                // platform code (not a UUID) is named in the snapshot only.
                let target = Uuid::parse_str(&code).unwrap_or_default();
                let event = audit(&actor, "workplace_kind.update", "workplace_kind", target, admitted,
                    json!({ "code": code, "label": next_label, "active": active }))?;
                finish(tx, &actor, &Outcome { target: None, change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                Ok((one(tx, &code).await?, vec![event]))
            })
        })
        .await
    }

    /// Set (or clear) the kind of one 사업장.
    ///
    /// # Errors
    /// `workplace_not_found`, `workplace_voided`, `kind_code: invalid_choice | inactive_choice`.
    pub async fn set_workplace_kind(
        &self,
        actor: &Actor,
        id: Uuid,
        cmd: SetWorkplaceKind,
    ) -> Result<Saved<WorkplaceView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let replayed = claim(
                    tx,
                    &actor,
                    "workplace.kind",
                    json!({ "workplace": id, "input": cmd }),
                )
                .await?;
                if let Some(done) = replayed {
                    let (entity, _, _) = lock_workplace(tx, id).await?;
                    let today = today_kst(tx).await?;
                    let record = one_view(tx, entity, id, today).await?;
                    return Ok((
                        Saved {
                            record,
                            warnings: Vec::new(),
                            change_mode: done.change_mode.unwrap_or_default(),
                        },
                        vec![],
                    ));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let (entity, _, _) = lock_workplace(tx, id).await?;
                let current: Option<String> =
                    sqlx::query_scalar("SELECT kind_code FROM workplaces WHERE id = $1")
                        .bind(id)
                        .fetch_one(tx.as_mut())
                        .await?;
                let kind = usable_kind(tx, cmd.kind_code.as_deref(), current.as_deref()).await?;
                sqlx::query("UPDATE workplaces SET kind_code = $2 WHERE id = $1")
                    .bind(id)
                    .bind(&kind)
                    .execute(tx.as_mut())
                    .await?;
                let event = audit(
                    &actor,
                    "workplace.kind",
                    "workplace",
                    id,
                    admitted,
                    json!({ "kind_code": kind, "previous": current }),
                )?;
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
                let today = today_kst(tx).await?;
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
