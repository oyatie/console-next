//! UX-R3 STRUCT company-15 (catalog company-19): withdraw a 법인's close
//! (종료 취소) when the business goes on. The 사업장 and 사업자등록 that closed
//! with it reopen in the same command — each gets back the revision it had
//! before the close (kept in its history) and every 사업장 its SITE unit — and
//! the 법인 reads open again (0336). Grants ended with the close stay ended.

use console_entity_application::{Actor, CloseWithdrawal, LegalEntityView, Saved};
use console_entity_domain::Refusal;
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use crate::closure::per_record;
use crate::command::{Outcome, claim, command_id, finish};
use crate::entity_close::closed_with;
use crate::org_units::OrgUnitSetupWritePort;
use crate::revision_copy::{Copy, RevisionAt, append_copy};
use crate::site_unit::workplace_unit;
use crate::{PgEntityError, PgEntityStore, admit, audit, today_kst};

const REASON: &str = console_entity_domain::SystemReason::LegalEntityCloseWithdrawn.as_str();

impl PgEntityStore {
    /// Withdraw the close of `id`.
    ///
    /// # Errors
    /// `legal_entity_not_found` (404), `legal_entity_not_closed` (409), field
    /// issue `why`, or database faults.
    pub async fn withdraw_close(
        &self,
        actor: &Actor,
        id: Uuid,
        cmd: CloseWithdrawal,
        port: std::sync::Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<Saved<LegalEntityView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "legal_entity.close_withdraw", json!({ "id": id, "withdrawal": cmd })).await? {
                    let record = crate::legal_entity::one(tx, id, None, true).await?;
                    return Ok((Saved { record, warnings: vec![], change_mode: done.change_mode.unwrap_or_default() }, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let head: Option<(Option<time::Date>, Option<String>)> =
                    sqlx::query_as("SELECT closed_on, close_reason_code FROM legal_entities WHERE id = $1 AND voided_at IS NULL FOR UPDATE")
                        .bind(id)
                        .fetch_optional(tx.as_mut())
                        .await?;
                let (Some(on), Some(reason)) = head.ok_or_else(|| Refusal::not_found("legal_entity_not_found"))? else {
                    return Err(Refusal::conflict("legal_entity_not_closed", "only a closed legal entity's close is withdrawn").into());
                };
                let mut is = console_entity_domain::Issues::default();
                let why = is.text("why", cmd.why.as_deref(), 200, true);
                let why = is.finish_opt(|| why)?;
                let today = today_kst(tx).await?;
                let base = command_id(&actor)?;
                let workplaces = closed_with(tx, false, id, on).await?;
                let registrations = closed_with(tx, true, id, on).await?;
                // A 사업장 reopens on its registration, so the registrations go first.
                for (registration, ids) in [(true, &registrations), (false, &workplaces)] {
                    for r in ids {
                        let at = RevisionAt { admitted, actor: actor.user, command: per_record(base, *r) };
                        append_copy(tx, registration, *r, Copy::Reopened, REASON, at).await?;
                        let sql = if registration {
                            "UPDATE business_registrations SET closed_on = NULL WHERE id = $1"
                        } else {
                            "UPDATE workplaces SET closed_on = NULL WHERE id = $1"
                        };
                        sqlx::query(sql).bind(r).execute(tx.as_mut()).await?;
                    }
                }
                for w in &workplaces {
                    workplace_unit(tx, &actor, *w, today, admitted, port.as_ref()).await?;
                }
                sqlx::query("SELECT set_config('app.entity_close_withdraw', 'on', true)").execute(tx.as_mut()).await?;
                sqlx::query("UPDATE legal_entities SET closed_on = NULL, close_reason_code = NULL WHERE id = $1")
                    .bind(id)
                    .execute(tx.as_mut())
                    .await?;
                sqlx::query("SELECT set_config('app.entity_close_withdraw', '', true)").execute(tx.as_mut()).await?;
                let event = audit(&actor, "legal_entity.close_withdraw", "legal_entity", id, admitted, json!({
                    "from": { "closed_on": on.to_string(), "reason_code": reason },
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
