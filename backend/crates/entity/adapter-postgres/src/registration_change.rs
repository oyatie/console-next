//! MR-18: a 사업장 moves to another 사업자등록 (its own certificate, or a
//! 종사업장 of a 사업자단위과세 one) or gets another 종사업장 일련번호, from a
//! date. The head follows; `workplace_registration_changes` keeps before and
//! after (부가세법 §8③–⑤; 시행규칙 별지 제7호서식 부표).

use console_entity_application::{Actor, Saved, WorkplaceView};
use console_entity_domain::Refusal;
use console_entity_domain::correction::{RegistrationChangeInput, validate_registration_change};
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::command::{Outcome, claim, command_id, finish};
use crate::workplace::{lock_entity, lock_workplace, one_view, registration_facts};
use crate::{PgEntityError, PgEntityStore, Tx, admit, audit, today_kst};

/// The 사업장 leaves the registration it holds (its own certificate): only
/// when nobody else files under it; then it has no holder.
async fn release_holder(
    tx: &mut Tx<'_>,
    workplace: Uuid,
    registration: Uuid,
) -> Result<(), PgEntityError> {
    let row = sqlx::query(
        "SELECT holder_workplace_id, (SELECT count(*) FROM workplaces w WHERE w.registration_id = h.id \
           AND w.id <> $2 AND w.voided_at IS NULL) AS others \
         FROM business_registrations h WHERE h.id = $1 FOR UPDATE",
    )
    .bind(registration)
    .bind(workplace)
    .fetch_one(tx.as_mut())
    .await?;
    if row.try_get::<Option<Uuid>, _>("holder_workplace_id")? != Some(workplace) {
        return Ok(());
    }
    let others: i64 = row.try_get("others")?;
    if others > 0 {
        return Err(Refusal::conflict(
            "registration_holder_in_use",
            format!("{others} other workplaces file under the registration this workplace holds"),
        )
        .with_remedy("move_workplaces_first")
        .into());
    }
    sqlx::query("UPDATE business_registrations SET holder_workplace_id = NULL WHERE id = $1")
        .bind(registration)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

impl PgEntityStore {
    /// Change the registration link and/or 종사업장 일련번호 of a 사업장, dated
    /// on or before today (SETUP: immediate; OPERATING: governed).
    ///
    /// # Errors
    /// Field issues (`registration_unchanged`, `registration_of_other_entity`,
    /// `sub_serial` required/not applicable/taken, `date_in_future`),
    /// `registration_holder_in_use`, or database faults.
    pub async fn change_workplace_registration(
        &self,
        actor: &Actor,
        id: Uuid,
        input: RegistrationChangeInput,
    ) -> Result<Saved<WorkplaceView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let request = json!({ "id": id, "change": input });
                if let Some(done) = claim(tx, &actor, "workplace.change_registration", request).await? {
                    let entity: Uuid = sqlx::query_scalar("SELECT legal_entity_id FROM workplaces WHERE id = $1")
                        .bind(id)
                        .fetch_one(tx.as_mut())
                        .await?;
                    let today = today_kst(tx).await?;
                    let record = one_view(tx, entity, id, today).await?;
                    return Ok((Saved { record, warnings: vec![], change_mode: done.change_mode.unwrap_or_default() }, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let (entity, registration, _) = lock_workplace(tx, id).await?;
                let today = today_kst(tx).await?;
                lock_entity(tx, entity).await?;
                let serial: Option<String> = sqlx::query_scalar("SELECT sub_serial FROM workplaces WHERE id = $1")
                    .bind(id)
                    .fetch_one(tx.as_mut())
                    .await?;
                let (of_other, _) = registration_facts(tx, entity, input.registration_id, Some(id)).await?;
                let primary: bool = sqlx::query_scalar("SELECT primary_workplace_id = $2 FROM legal_entities WHERE id = $1").bind(entity).bind(id).fetch_one(tx.as_mut()).await?;
                if primary { crate::name_evidence::primary_registration(tx, entity, input.registration_id).await?; }
                let change = validate_registration_change(&input, of_other, today)?;
                let to_serial = change.sub_serial.as_ref().map(|s| s.as_str().to_owned());
                if (change.registration_id, &to_serial) == (registration, &serial) {
                    return Err(Refusal::field("registration_id", "registration_unchanged").into());
                }
                if let Some(old) = registration.filter(|old| Some(*old) != change.registration_id) {
                    release_holder(tx, id, old).await?;
                }
                sqlx::query(
                    "INSERT INTO workplace_registration_changes (org_id, workplace_id, from_registration_id, from_sub_serial, \
                       to_registration_id, to_sub_serial, effective_from, reason_code, change_mode, actor_id, command_id) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
                )
                .bind(id)
                .bind(registration)
                .bind(&serial)
                .bind(change.registration_id)
                .bind(&to_serial)
                .bind(change.effective_from)
                .bind(change.reason_code.as_str())
                .bind(admitted.mode.as_str())
                .bind(*actor.user.as_uuid())
                .bind(command_id(&actor)?)
                .execute(tx.as_mut())
                .await?;
                sqlx::query("UPDATE workplaces SET registration_id = $2, sub_serial = $3 WHERE id = $1")
                    .bind(id)
                    .bind(change.registration_id)
                    .bind(&to_serial)
                    .execute(tx.as_mut())
                    .await?;
                if let (Some(new), false) = (change.registration_id, of_other) {
                    sqlx::query("UPDATE business_registrations SET holder_workplace_id = $2 WHERE id = $1 AND holder_workplace_id IS NULL")
                        .bind(new)
                        .bind(id)
                        .execute(tx.as_mut())
                        .await?;
                }
                let event = audit(&actor, "workplace.change_registration", "workplace", id, admitted, json!({
                    "from_registration_id": registration, "from_sub_serial": serial,
                    "to_registration_id": change.registration_id, "to_sub_serial": to_serial,
                    "effective_from": change.effective_from.to_string(), "reason_code": change.reason_code,
                }))?;
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = one_view(tx, entity, id, today).await?;
                Ok((Saved { record, warnings: vec![], change_mode: admitted.mode.as_str().into() }, vec![event]))
            })
        })
        .await
    }
}
