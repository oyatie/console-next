//! Employment ↔ 법인/사업장 by id, the 「회사 이름 정리」 cleanup, and 사업장 void.

use console_entity_application::{
    Actor, AssignmentView, BindAssignment, MapCompanyText, UnmappedCompany, VoidRecord,
};
use console_entity_domain::Refusal;
use console_kernel_core::{ChangeMode, WriteClass};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::command::{Outcome, claim, command_id, finish};
use crate::legal_entity::void_reason;
use crate::org_units::OrgUnitSetupWritePort;
use crate::{PgEntityError, PgEntityStore, Tx, admit, audit};
use std::sync::Arc;

/// The 사업장 must belong to the 법인 and be open (MR-14: never closed).
async fn check_pair(tx: &mut Tx<'_>, entity: Uuid, workplace: Uuid) -> Result<(), PgEntityError> {
    let closed: Option<bool> = sqlx::query_scalar(
        "SELECT w.closed_on IS NOT NULL OR e.closed_on IS NOT NULL FROM workplaces w JOIN legal_entities e ON e.id = w.legal_entity_id \
           WHERE w.id = $1 AND w.legal_entity_id = $2 AND w.voided_at IS NULL AND e.voided_at IS NULL",
    )
    .bind(workplace)
    .bind(entity)
    .fetch_optional(tx.as_mut())
    .await?;
    match closed {
        Some(false) => Ok(()),
        Some(true) => Err(Refusal::field("workplace_id", "workplace_closed").into()),
        None => Err(Refusal::field("workplace_id", "workplace_of_other_entity").into()),
    }
}

fn view(r: &sqlx::postgres::PgRow) -> Result<AssignmentView, sqlx::Error> {
    Ok(AssignmentView {
        id: r.try_get("id")?,
        employee_id: r.try_get("employee_id")?,
        legal_entity_id: r.try_get("legal_entity_id")?,
        workplace_id: r.try_get("workplace_id")?,
        valid_from: r.try_get("valid_from")?,
        valid_to: r.try_get("valid_to")?,
        cause: r.try_get("cause")?,
    })
}

/// A replayed bind: the assignment row it wrote.
async fn one(tx: &mut Tx<'_>, id: Option<Uuid>) -> Result<AssignmentView, PgEntityError> {
    let id = id.ok_or_else(|| Refusal::not_found("assignment_not_found"))?;
    let row = sqlx::query(
        "SELECT id, employee_id, legal_entity_id, workplace_id, valid_from, valid_to, cause FROM employment_assignments WHERE id = $1",
    )
        .bind(id)
        .fetch_one(tx.as_mut())
        .await?;
    Ok(view(&row)?)
}

impl PgEntityStore {
    /// Bind an employee to a 법인 and 사업장 from `valid_from`, closing the
    /// open assignment the day before (a 전근/전적 split). The employee row is
    /// locked first, which serialises concurrent writers (overlap backstop:
    /// the assignment no-overlap trigger).
    ///
    /// # Errors
    /// Field issues, `employee_not_found`, `assignment_overlap`, or database faults.
    pub async fn bind_assignment(
        &self,
        actor: &Actor,
        cmd: BindAssignment,
    ) -> Result<AssignmentView, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "employment_assignment.bind", serde_json::to_value(&cmd)?).await? {
                    return Ok((one(tx, done.target).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let mut is = console_entity_domain::Issues::default();
                if cmd.legal_entity_id.is_none() {
                    is.push("legal_entity_id", "required");
                }
                if cmd.workplace_id.is_none() {
                    is.push("workplace_id", "required");
                }
                let from = is.date("valid_from", cmd.valid_from.as_deref(), true, None);
                let (entity, workplace, from) = is.finish_opt(|| Some((cmd.legal_entity_id?, cmd.workplace_id?, from?)))?;
                check_pair(tx, entity, workplace).await?;
                let status: Option<String> = sqlx::query_scalar("SELECT employment_status FROM employees WHERE id = $1 FOR UPDATE")
                    .bind(cmd.employee_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
                if status.is_none() {
                    return Err(Refusal::field("employee_id", "employee_not_found").into());
                }
                let open = sqlx::query(
                    "SELECT id, valid_from, legal_entity_id, workplace_id FROM employment_assignments \
                     WHERE employee_id = $1 AND superseded_at IS NULL AND valid_to IS NULL",
                )
                .bind(cmd.employee_id)
                .fetch_optional(tx.as_mut())
                .await?;
                let mut cause = if admitted.mode == ChangeMode::Setup { "SETUP_BIND" } else { "HIRE" };
                if let Some(open) = open {
                    let open_id: Uuid = open.try_get("id")?;
                    let open_from: time::Date = open.try_get("valid_from")?;
                    let open_entity: Option<Uuid> = open.try_get("legal_entity_id")?;
                    let open_workplace: Option<Uuid> = open.try_get("workplace_id")?;
                    if open_from == from && open_entity == Some(entity) && open_workplace == Some(workplace) {
                        // The same placement again (a client that still binds after a
                        // registration that placed the person, MR-22): nothing changes.
                        finish(tx, &actor, &Outcome { target: Some(open_id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                        return Ok((one(tx, Some(open_id)).await?, vec![]));
                    }
                    if open_from >= from {
                        // Same-day or back-dated rebind replaces the row (history kept).
                        sqlx::query("UPDATE employment_assignments SET superseded_at = now() WHERE id = $1")
                            .bind(open_id).execute(tx.as_mut()).await?;
                        cause = "CORRECTION";
                    } else {
                        sqlx::query("UPDATE employment_assignments SET valid_to = $2 WHERE id = $1")
                            .bind(open_id).bind(from).execute(tx.as_mut()).await?;
                        if open_entity.is_some_and(|e| e != entity) {
                            // 전적 needs the group-transfer command (exit + rehire, consent evidence).
                            return Err(Refusal::conflict("entity_change_needs_group_transfer",
                                "moving to another legal entity is a 전적 (exit and re-hire)")
                                .with_remedy("start_group_transfer").into());
                        }
                        cause = "TRANSFER";
                    }
                }
                // UX-R1 PLACEMENT (org-01): the 사업장 follows the 부서; a 전보 moves both. After
                // the 법인 check, so a change of 법인 still reads as a 전적.
                if crate::employment_hire::unit_contradicts(tx.as_mut(), *actor.org.as_uuid(), cmd.employee_id, workplace).await?.is_some() {
                    let mut refused = Refusal::field("workplace_id", "org_unit_at_other_workplace").with_remedy("transfer_instead");
                    refused.code = "org_unit_at_other_workplace";
                    refused.message = "the employee's 부서 sits at another 사업장; move them with a 전보".into();
                    return Err(refused.into());
                }
                let id: Uuid = sqlx::query_scalar(
                    "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7) RETURNING id",
                )
                .bind(cmd.employee_id)
                .bind(entity)
                .bind(workplace)
                .bind(from)
                .bind(cause)
                .bind(*actor.user.as_uuid())
                .bind(command_id(&actor)?)
                .fetch_one(tx.as_mut())
                .await?;
                let event = audit(&actor, "employment_assignment.bind", "employee", cmd.employee_id, admitted, json!({
                    "assignment_id": id, "legal_entity_id": entity, "workplace_id": workplace,
                    "valid_from": from.to_string(), "cause": cause,
                }))?;
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let view = AssignmentView { id, employee_id: cmd.employee_id, legal_entity_id: Some(entity), workplace_id: Some(workplace), valid_from: from, valid_to: None, cause: cause.into() };
                Ok((view, vec![event]))
            })
        })
        .await
    }

    /// One employee's placements, newest first (superseded corrections left out).
    ///
    /// # Errors
    /// Database faults.
    pub async fn list_assignments(
        &self,
        actor: &Actor,
        employee_id: Uuid,
    ) -> Result<Vec<AssignmentView>, PgEntityError> {
        let granted = actor.scope.granted().map(<[Uuid]>::to_vec);
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    "SELECT id, employee_id, legal_entity_id, workplace_id, valid_from, valid_to, cause FROM employment_assignments \
                     WHERE employee_id = $1 AND superseded_at IS NULL \
                       AND ($2::uuid[] IS NULL OR legal_entity_id = ANY($2) OR workplace_id = ANY($2)) ORDER BY valid_from DESC",
                )
                .bind(employee_id)
                .bind(granted)
                .fetch_all(tx.as_mut())
                .await?;
                Ok(rows.iter().map(view).collect::<Result<_, _>>()?)
            })
        })
        .await
    }

    /// Distinct legacy company texts whose employees have no mapped 법인.
    ///
    /// # Errors
    /// Database faults.
    pub async fn unmapped_companies(
        &self,
        actor: &Actor,
    ) -> Result<Vec<UnmappedCompany>, PgEntityError> {
        with_org_conn(&self.pool, actor.org, |tx| {
            Box::pin(async move {
                let rows: Vec<(String, i64)> = sqlx::query_as(
                    "SELECT btrim(e.company), count(*) FROM employment_assignments a JOIN employees e ON e.id = a.employee_id \
                     WHERE a.superseded_at IS NULL AND a.cause = 'MIGRATION_UNMAPPED' \
                     GROUP BY btrim(e.company) ORDER BY count(*) DESC, btrim(e.company)",
                )
                .fetch_all(tx.as_mut())
                .await?;
                Ok(rows.into_iter().map(|(company_text, employees)| UnmappedCompany { company_text, employees }).collect())
            })
        })
        .await
    }

    /// Map every unmapped employee with this company text to one 법인 (and
    /// 사업장), per text not per person. Returns how many were mapped.
    ///
    /// # Errors
    /// Field issues or database faults.
    pub async fn map_company_text(
        &self,
        actor: &Actor,
        cmd: MapCompanyText,
    ) -> Result<i64, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "employment_assignment.map_company", serde_json::to_value(&cmd)?).await? {
                    return Ok((done.count.unwrap_or_default(), vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let mut is = console_entity_domain::Issues::default();
                let text = is.text("company_text", cmd.company_text.as_deref(), 500, true);
                if cmd.legal_entity_id.is_none() { is.push("legal_entity_id", "required"); }
                if cmd.workplace_id.is_none() { is.push("workplace_id", "required"); }
                let (text, entity, workplace) = is.finish_opt(|| Some((text?, cmd.legal_entity_id?, cmd.workplace_id?)))?;
                check_pair(tx, entity, workplace).await?;
                let rows = sqlx::query(
                    "SELECT a.id, a.employee_id, a.valid_from, a.valid_to FROM employment_assignments a \
                     JOIN employees e ON e.id = a.employee_id \
                     WHERE a.superseded_at IS NULL AND a.cause = 'MIGRATION_UNMAPPED' AND btrim(e.company) = $1 \
                     ORDER BY a.employee_id FOR UPDATE OF a",
                )
                .bind(&text)
                .fetch_all(tx.as_mut())
                .await?;
                for r in &rows {
                    let id: Uuid = r.try_get("id")?;
                    sqlx::query("UPDATE employment_assignments SET superseded_at = now() WHERE id = $1").bind(id).execute(tx.as_mut()).await?;
                    sqlx::query(
                        "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, valid_to, cause, actor_id, command_id) \
                         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5, 'CORRECTION', $6, $7)",
                    )
                    .bind(r.try_get::<Uuid, _>("employee_id")?)
                    .bind(entity)
                    .bind(workplace)
                    .bind(r.try_get::<time::Date, _>("valid_from")?)
                    .bind(r.try_get::<Option<time::Date>, _>("valid_to")?)
                    .bind(*actor.user.as_uuid())
                    .bind(command_id(&actor)?)
                    .execute(tx.as_mut())
                    .await?;
                }
                let mapped = i64::try_from(rows.len()).unwrap_or(i64::MAX);
                let event = audit(&actor, "employment_assignment.map_company", "legal_entity", entity, admitted, json!({
                    "company_text": text, "workplace_id": workplace, "employees": mapped,
                }))?;
                finish(tx, &actor, &Outcome { target: Some(entity), change_mode: Some(admitted.mode.as_str().into()), count: Some(mapped) }).await?;
                Ok((mapped, vec![event]))
            })
        })
        .await
    }

    /// Undo a mistaken 사업장 during setup.
    ///
    /// # Errors
    /// `phase_not_setup`, `record_in_use`, or database faults.
    pub async fn void_workplace(
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
                    "workplace.void",
                    json!({ "id": id, "void": cmd }),
                )
                .await?
                .is_some()
                {
                    return Ok(((), vec![]));
                }
                let admitted = crate::record_end::admit_void(tx, "workplace_id", id).await?;
                let reason = void_reason(cmd.reason_code.as_deref())?;
                let event = crate::workplace_tx::void_workplace_in_tx(
                    tx,
                    &actor,
                    admitted,
                    id,
                    &reason,
                    port.as_ref(),
                )
                .await?;
                finish(tx, &actor, &Outcome::default()).await?;
                Ok(((), vec![event]))
            })
        })
        .await
    }
}
