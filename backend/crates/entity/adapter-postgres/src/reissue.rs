//! 등록증 재발급·정정: a newly issued 사업자등록증 recorded as one dated,
//! evidenced change. The registration's revision (and, when the certificate
//! changed what the 법인 records — 대표자, 법인명, 본점 — the 법인's) is
//! appended with the certificate linked as its evidence; the certificate kept
//! before stays, superseded. SETUP applies at once; after 운영 시작 the write is
//! governed (legal_entity_manage, change mode GOVERNED, audited).

use console_entity_application::{Actor, RegistrationReissue, RegistrationView, Revision, Saved};
use console_entity_domain::correction::{ReissueInput, validate_reissue};
use console_entity_domain::reissue::{reissue_entity_from, reissue_registration_from};
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::documents::attach_in_tx;
use crate::legal_entity_tx::revise_entity_in_tx;
use crate::registration::{one, registration_entity, replay};
use crate::registration_revision::revise_registration_in_tx;
use crate::{PgEntityError, PgEntityStore, admit, audit, today_kst};

impl PgEntityStore {
    /// Record a reissued or corrected 사업자등록증 of registration `id`.
    ///
    /// # Errors
    /// Field issues (`document_id`, `reason`, `effective_from`,
    /// `cert_issued_on`, the registration's and the 법인's own), the document's
    /// refusals (`document_not_found`, `document_attached_elsewhere`,
    /// `document_not_certificate`, `document_not_new`), `stale_revision`, or
    /// database faults.
    pub async fn reissue_registration(
        &self,
        actor: &Actor,
        id: Uuid,
        input: RegistrationReissue,
    ) -> Result<Saved<RegistrationView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "business_registration.reissue", json!({ "id": id, "reissue": input })).await? {
                    let entity = registration_entity(tx, id).await?;
                    return Ok((replay(tx, entity, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let today = today_kst(tx).await?;
                let envelope = ReissueInput { document_id: input.document_id, reason: input.reason.clone(), effective_from: input.effective_from.clone() };
                let r = validate_reissue(&envelope, input.registration.input.cert_issued_on.as_deref(), today)?;
                let (effective_from, reason) = (Some(r.effective_from.to_string()), Some(r.reason.as_str().to_owned()));
                // Full-state revisions: never dated under the state in force nor a scheduled one (either would hide or
                // undo it). A concurrent revision is caught by the expected version.
                let (in_force, latest): (Option<time::Date>, Option<time::Date>) = sqlx::query_as(
                    "SELECT max(effective_from) FILTER (WHERE effective_from <= $2), max(effective_from) \
                     FROM business_registration_revisions WHERE registration_id = $1",
                )
                .bind(id)
                .bind(today)
                .fetch_one(tx.as_mut())
                .await?;
                reissue_registration_from(r.effective_from, in_force, latest, today)?;
                let reg = &input.registration;
                let rev = Revision { expected_version: reg.expected_version, effective_from: effective_from.clone(), reason_code: reason.clone(), input: reg.input.clone() };
                let (entity, mut warnings, mut events) =
                    revise_registration_in_tx(tx, &actor, admitted, id, &rev, reg.status.clone(), Some(r.document_id)).await?;
                events.extend(attach_in_tx(tx, &actor, r.document_id, entity, Some(id)).await?.1);
                if let Some(e) = &input.entity {
                    let latest: Option<time::Date> = sqlx::query_scalar("SELECT max(effective_from) FROM legal_entity_revisions WHERE legal_entity_id = $1")
                        .bind(entity)
                        .fetch_one(tx.as_mut())
                        .await?;
                    let (from, moved) = reissue_entity_from(r.effective_from, latest, today)?;
                    warnings.extend(moved);
                    let effective_from = Some(from.to_string());
                    let rev = Revision { expected_version: e.expected_version, effective_from, reason_code: reason, input: e.input.clone() };
                    let (more, event) = revise_entity_in_tx(tx, &actor, admitted, entity, &rev).await?;
                    warnings.extend(more);
                    events.push(event);
                }
                events.push(audit(&actor, "business_registration.reissue", "business_registration", id, admitted, json!({
                    "reason": r.reason.as_str(), "effective_from": r.effective_from.to_string(), "document_id": r.document_id,
                    "legal_entity_changed": input.entity.is_some(),
                }))?);
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = one(tx, entity, id).await?;
                Ok((Saved { record, warnings, change_mode: admitted.mode.as_str().into() }, events))
            })
        })
        .await
    }
}
