//! A dated change to a 사업장's 4대보험 relations (insurance PUT): one new
//! revision per listed insurer, in one audited, idempotent transaction.

use console_entity_application::{Actor, InsuranceRevision, Saved, WorkplaceView};
use console_entity_domain::insurance_change::validate_insurance_change;
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::workplace::{lock_entity, lock_workplace, one_view};
use crate::workplace_revision::insert_insurance;
use crate::{
    PgEntityError, PgEntityStore, RevisionMeta, admit, audit, ensure_version, revision_envelope,
    today_kst,
};

impl PgEntityStore {
    /// `expected_version` is the highest 4대보험 revision version of the
    /// 사업장 the client read (0 when it has none): any insurance change since
    /// is 409 `stale_revision`.
    ///
    /// # Errors
    /// Field refusals, `stale_revision`, the phase refusal, or database faults.
    pub async fn revise_insurance(
        &self,
        actor: &Actor,
        id: Uuid,
        rev: InsuranceRevision,
    ) -> Result<Saved<WorkplaceView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "workplace.insurance", json!({ "id": id, "revision": rev })).await? {
                    let (entity, _, _) = lock_workplace(tx, id).await?;
                    let today = today_kst(tx).await?;
                    let record = one_view(tx, entity, id, today).await?;
                    return Ok((Saved { record, warnings: Vec::new(), change_mode: done.change_mode.unwrap_or_default() }, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                // The envelope wants expected_version ≥ 1; a 사업장 with no
                // insurance row yet is read as version 0.
                let mut envelope_rev = rev.clone();
                envelope_rev.expected_version = rev.expected_version.map(|v| v.max(1));
                let env = revision_envelope(&envelope_rev)?;
                let (entity, _, _) = lock_workplace(tx, id).await?;
                lock_entity(tx, entity).await?;
                let current: i32 = sqlx::query_scalar(
                    "SELECT COALESCE(max(version), 0) FROM workplace_insurance_revisions WHERE workplace_id = $1",
                )
                .bind(id)
                .fetch_one(tx.as_mut())
                .await?;
                ensure_version(rev.expected_version.unwrap_or_default(), current)?;
                let drafts = validate_insurance_change(id, &rev.input.insurers)?;
                let main_elsewhere: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM workplaces w WHERE w.id = ANY($1) AND (w.legal_entity_id <> $2 OR w.voided_at IS NOT NULL))",
                )
                .bind(drafts.iter().filter_map(|d| d.main_workplace_id).collect::<Vec<_>>())
                .bind(entity)
                .fetch_one(tx.as_mut())
                .await?;
                if main_elsewhere {
                    return Err(console_entity_domain::Refusal::field("main_workplace_id", "workplace_of_other_entity").into());
                }
                for draft in &drafts {
                    let meta = RevisionMeta {
                        version: 0, // insert_insurance numbers per insurer
                        effective_from: env.effective_from,
                        reason_code: env.reason.clone().into(),
                        admitted,
                        actor: &actor,
                        payload: serde_json::to_value(draft)?,
                    };
                    insert_insurance(tx, id, draft, &meta).await?;
                }
                let insurers: Vec<&str> = drafts.iter().map(|d| d.insurer.as_str()).collect();
                let event = audit(&actor, "workplace.insurance.revise", "workplace", id, admitted,
                    json!({ "insurers": insurers, "effective_from": env.effective_from.to_string(), "reason_code": env.reason }))?;
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let today = today_kst(tx).await?;
                let record = one_view(tx, entity, id, today).await?;
                Ok((Saved { record, warnings: Vec::new(), change_mode: admitted.mode.as_str().into() }, vec![event]))
            })
        })
        .await
    }
}
