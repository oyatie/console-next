//! One-time 법인명 reviews (20261013153646645): a registration 상호 that differed from the
//! entity's name when the name became single-source. A person settles each:
//! keep the entity's name, or take the 상호 by a dated 정정.

use console_entity_application::{Actor, LegalEntityView, NameReview, Saved, SettleNameReview};
use console_entity_domain::Refusal;
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::legal_entity::one;
use crate::legal_entity_tx::revise_entity_in_tx;
use crate::{PgEntityError, PgEntityStore, Tx, admit, audit};

/// The open reviews of `ids`, by entity.
pub(crate) async fn open(
    tx: &mut Tx<'_>,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<NameReview>>, PgEntityError> {
    let rows = sqlx::query(
        "SELECT id, legal_entity_id, registration_id, entity_name, registration_name \
         FROM legal_entity_name_reviews WHERE legal_entity_id = ANY($1) AND settled_at IS NULL \
         ORDER BY created_at, id",
    )
    .bind(ids)
    .fetch_all(tx.as_mut())
    .await?;
    let mut out: HashMap<Uuid, Vec<NameReview>> = HashMap::new();
    for r in rows {
        out.entry(r.try_get("legal_entity_id")?)
            .or_default()
            .push(NameReview {
                id: r.try_get("id")?,
                registration_id: r.try_get("registration_id")?,
                entity_name: r.try_get("entity_name")?,
                registration_name: r.try_get("registration_name")?,
            });
    }
    Ok(out)
}

impl PgEntityStore {
    /// Settle one open review of 법인 `id`.
    ///
    /// # Errors
    /// `name_review_not_found` (unknown, settled, or another 법인's), a
    /// `revision` whose name is not the review's 상호 (`name_review_choice`),
    /// the revision's own refusals, or database faults.
    pub async fn settle_name_review(
        &self,
        actor: &Actor,
        id: Uuid,
        review: Uuid,
        body: SettleNameReview,
    ) -> Result<Saved<LegalEntityView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let op = "legal_entity.name_review.settle";
                if let Some(done) = claim(tx, &actor, op, json!({ "id": id, "review": review, "body": body })).await? {
                    return Ok((crate::legal_entity::replay(tx, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let row = sqlx::query(
                    "SELECT entity_name, registration_name FROM legal_entity_name_reviews \
                     WHERE id = $1 AND legal_entity_id = $2 AND settled_at IS NULL FOR UPDATE",
                )
                .bind(review)
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| Refusal::not_found("name_review_not_found"))?;
                let offered: String = row.try_get("registration_name")?;
                let mut warnings = Vec::new();
                let mut events = Vec::new();
                let picked = match &body.revision {
                    Some(rev) => {
                        let name = rev.input.name.as_deref().map(str::trim).unwrap_or_default();
                        if name != offered.trim() {
                            return Err(Refusal::field("name", "name_review_choice").into());
                        }
                        let (w, event) = revise_entity_in_tx(tx, &actor, admitted, id, rev).await?;
                        warnings = w;
                        events.push(event);
                        name.to_owned()
                    }
                    None => one(tx, id, None, true)
                        .await?
                        .current
                        .map(|c| c.name)
                        .unwrap_or_default(),
                };
                sqlx::query(
                    "UPDATE legal_entity_name_reviews SET settled_at = now(), settled_by = $2, settled_name = $3 WHERE id = $1",
                )
                .bind(review)
                .bind(*actor.user.as_uuid())
                .bind(&picked)
                .execute(tx.as_mut())
                .await?;
                events.push(audit(&actor, op, "legal_entity", id, admitted, json!({
                    "review": review, "kept": if body.revision.is_some() { "registration" } else { "entity" },
                }))?);
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = one(tx, id, None, true).await?;
                Ok((Saved { record, warnings, change_mode: admitted.mode.as_str().into() }, events))
            })
        })
        .await
    }
}
