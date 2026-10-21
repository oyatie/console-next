//! MR-15: close a 법인 (해산 / 폐업). Its open 사업장 and 사업자등록 close
//! on the same date through [`crate::closure`]; the close is set once (0264).

use console_entity_application::{
    Actor, CloseCorrection, CloseLegalEntity, LegalEntityView, Saved,
};
use console_entity_domain::Refusal;
use console_entity_domain::codes::CloseReason;
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use crate::closure::{close_one, ensure_vacant, per_record};
use crate::command::{Outcome, claim, command_id, finish};
use crate::org_units::OrgUnitSetupWritePort;
use crate::site_unit::dissolve_sites;
use crate::{PgEntityError, PgEntityStore, admit, audit, today_kst};

impl PgEntityStore {
    /// Close a 법인 (MR-15): 해산 or 폐업 on `closed_on` (no later than
    /// today). Its open 사업장 and 사업자등록 close on the same date (CLOSED
    /// revisions), their SITE units dissolve, and the close is set once.
    /// Refused while people or 부서 remain anywhere in it.
    ///
    /// # Errors
    /// Field issues (`closed_on`, `reason_code`), `legal_entity_not_open`,
    /// `record_in_use`, or database faults.
    pub async fn close_entity(
        &self,
        actor: &Actor,
        id: Uuid,
        cmd: CloseLegalEntity,
        port: std::sync::Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<Saved<LegalEntityView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "legal_entity.close", json!({ "id": id, "close": cmd })).await? {
                    let record = crate::legal_entity::one(tx, id, None, true).await?;
                    return Ok((Saved { record, warnings: vec![], change_mode: done.change_mode.unwrap_or_default() }, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                // The revise paths lock a 사업장 or 사업자등록 before its 법인: same order here.
                let workplaces: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM workplaces WHERE legal_entity_id = $1 AND voided_at IS NULL AND closed_on IS NULL ORDER BY id FOR UPDATE",
                )
                .bind(id)
                .fetch_all(tx.as_mut())
                .await?;
                let registrations: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM business_registrations WHERE legal_entity_id = $1 AND voided_at IS NULL AND closed_on IS NULL ORDER BY id FOR UPDATE",
                )
                .bind(id)
                .fetch_all(tx.as_mut())
                .await?;
                crate::workplace::lock_entity(tx, id).await?;
                let today = today_kst(tx).await?;
                let mut is = console_entity_domain::Issues::default();
                let on = is.date("closed_on", cmd.closed_on.as_deref(), true, Some(today));
                let reason = is.choice("reason_code", cmd.reason_code.as_deref(), true, CloseReason::parse);
                let (on, reason) = is.finish_opt(|| Some((on?, reason?)))?;
                ensure_vacant(tx, true, id, on).await?;
                let base = command_id(&actor)?;
                let user = actor.user;
                let close_reason = console_entity_domain::SystemReason::entity_close(reason).as_str();
                for w in &workplaces {
                    close_one(tx, false, *w, on, close_reason, admitted, user, per_record(base, *w)).await?;
                }
                dissolve_sites(tx, &actor, "legal_entity_id", id, today, port.as_ref()).await?;
                for r in &registrations {
                    close_one(tx, true, *r, on, close_reason, admitted, user, per_record(base, *r)).await?;
                }
                sqlx::query("UPDATE legal_entities SET closed_on = $2, close_reason_code = $3 WHERE id = $1")
                    .bind(id)
                    .bind(on)
                    .bind(reason.as_str())
                    .execute(tx.as_mut())
                    .await?;
                let event = audit(&actor, "legal_entity.close", "legal_entity", id, admitted, json!({
                    "closed_on": on.to_string(), "reason_code": reason.as_str(),
                    "workplaces": workplaces, "registrations": registrations,
                }))?;
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = crate::legal_entity::one(tx, id, None, true).await?;
                Ok((Saved { record, warnings: vec![], change_mode: admitted.mode.as_str().into() }, vec![event]))
            })
        })
        .await
    }
}

/// The open records the 법인's close closed with it on `on`: their newest
/// revision is the close's own (or an earlier correction of it).
pub(crate) async fn closed_with(
    tx: &mut crate::Tx<'_>,
    registrations: bool,
    entity: Uuid,
    on: time::Date,
) -> Result<Vec<Uuid>, crate::PgEntityError> {
    let sql = if registrations {
        "SELECT h.id FROM business_registrations h WHERE h.legal_entity_id = $1 AND h.closed_on = $2 AND h.voided_at IS NULL \
           AND (SELECT r.reason_code FROM business_registration_revisions r WHERE r.registration_id = h.id \
                ORDER BY r.version DESC LIMIT 1) = ANY($3) ORDER BY h.id FOR UPDATE"
    } else {
        "SELECT h.id FROM workplaces h WHERE h.legal_entity_id = $1 AND h.closed_on = $2 AND h.voided_at IS NULL \
           AND (SELECT r.reason_code FROM workplace_revisions r WHERE r.workplace_id = h.id \
                ORDER BY r.version DESC LIMIT 1) = ANY($3) ORDER BY h.id FOR UPDATE"
    };
    Ok(sqlx::query_scalar(sql)
        .bind(entity)
        .bind(on)
        .bind(
            console_entity_domain::SystemReason::CLOSED_WITH_ENTITY
                .map(console_entity_domain::SystemReason::as_str),
        )
        .fetch_all(tx.as_mut())
        .await?)
}

impl PgEntityStore {
    /// Correct a 법인's recorded close (catalog company-19): the 종료일 and
    /// 종료 사유 become the right ones, and the 사업장 and 사업자등록 that
    /// closed with it move to the same date (a CLOSED revision each). It
    /// never reopens anything; `why` is kept in the audit row.
    ///
    /// # Errors
    /// `legal_entity_not_closed` (409), field issues (`closed_on`,
    /// `reason_code`, `why`, `close_unchanged`), `record_in_use` when an
    /// earlier date would cut through someone still placed, or database faults.
    pub async fn correct_close(
        &self,
        actor: &Actor,
        id: Uuid,
        cmd: CloseCorrection,
    ) -> Result<Saved<LegalEntityView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "legal_entity.close_correct", json!({ "id": id, "correction": cmd })).await? {
                    let record = crate::legal_entity::one(tx, id, None, true).await?;
                    return Ok((Saved { record, warnings: vec![], change_mode: done.change_mode.unwrap_or_default() }, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let head: Option<(Option<time::Date>, Option<String>)> =
                    sqlx::query_as("SELECT closed_on, close_reason_code FROM legal_entities WHERE id = $1 AND voided_at IS NULL FOR UPDATE")
                        .bind(id)
                        .fetch_optional(tx.as_mut())
                        .await?;
                let (Some(old_on), Some(old_reason)) = head.ok_or_else(|| Refusal::not_found("legal_entity_not_found"))? else {
                    return Err(Refusal::conflict("legal_entity_not_closed", "only a closed legal entity's close is corrected").into());
                };
                let today = today_kst(tx).await?;
                let mut is = console_entity_domain::Issues::default();
                let on = is.date("closed_on", cmd.closed_on.as_deref(), true, Some(today));
                let reason = is.choice("reason_code", cmd.reason_code.as_deref(), true, CloseReason::parse);
                let why = is.text("why", cmd.why.as_deref(), 200, true);
                let (on, reason, why) = is.finish_opt(|| Some((on?, reason?, why?)))?;
                if (on, reason.as_str()) == (old_on, old_reason.as_str()) {
                    return Err(Refusal::field("closed_on", "close_unchanged").into());
                }
                ensure_vacant(tx, true, id, on).await?;
                let base = command_id(&actor)?;
                let workplaces = closed_with(tx, false, id, old_on).await?;
                let registrations = closed_with(tx, true, id, old_on).await?;
                for (registration, ids) in [(false, &workplaces), (true, &registrations)] {
                    for r in ids {
                        close_one(tx, registration, *r, on, console_entity_domain::SystemReason::LegalEntityCloseCorrected.as_str(), admitted, actor.user, per_record(base, *r)).await?;
                    }
                }
                sqlx::query("SELECT set_config('app.entity_close_correction', 'on', true)").execute(tx.as_mut()).await?;
                sqlx::query("UPDATE legal_entities SET closed_on = $2, close_reason_code = $3 WHERE id = $1")
                    .bind(id)
                    .bind(on)
                    .bind(reason.as_str())
                    .execute(tx.as_mut())
                    .await?;
                sqlx::query("SELECT set_config('app.entity_close_correction', '', true)").execute(tx.as_mut()).await?;
                let event = audit(&actor, "legal_entity.close_correct", "legal_entity", id, admitted, json!({
                    "from": { "closed_on": old_on.to_string(), "reason_code": old_reason },
                    "to": { "closed_on": on.to_string(), "reason_code": reason.as_str() },
                    "why": why, "workplaces": workplaces, "registrations": registrations,
                }))?;
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = crate::legal_entity::one(tx, id, None, true).await?;
                Ok((Saved { record, warnings: vec![], change_mode: admitted.mode.as_str().into() }, vec![event]))
            })
        })
        .await
    }
}
