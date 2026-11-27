// SPDX-License-Identifier: LicenseRef-Proprietary
//! Workplace head appointment (`PUT /api/v1/workplaces/{workplaceId}/head`).
//!
//! Appoints any non-exited employee in the tenant as head of an open workplace,
//! or clears the appointment when `head_employee_id` is `None`. Direct in both
//! phases (`WriteClass::EntityStructure`), idempotent via `entity_commands`,
//! and audited on `workplace.head`.

use console_entity_application::{Actor, Saved, SetWorkplaceHead, WorkplaceView};
use console_entity_domain::Refusal;
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::workplace::{lock_workplace, one_view};
use crate::{PgEntityError, PgEntityStore, admit, audit, today_kst};

impl PgEntityStore {
    /// Appoint or clear the head of an open workplace.
    ///
    /// # Errors
    /// `workplace_not_found`, `workplace_voided`, `workplace_closed`,
    /// `head_employee_id: head_unavailable`, or database faults.
    pub async fn set_workplace_head(
        &self,
        actor: &Actor,
        id: Uuid,
        cmd: SetWorkplaceHead,
    ) -> Result<Saved<WorkplaceView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let replayed = claim(
                    tx,
                    &actor,
                    "workplace.head",
                    json!({ "workplace": id, "input": cmd }),
                )
                .await?;
                if let Some(done) = replayed {
                    let (entity, _, _) = lock_workplace(tx, id).await?;
                    let today = today_kst(tx).await?;
                    let record = one_view(tx, entity, id, today).await?;
                    let change_mode = done.change_mode.unwrap_or_default();
                    return Ok((
                        Saved {
                            record,
                            warnings: Vec::new(),
                            change_mode,
                        },
                        vec![],
                    ));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let (entity, _, _) = lock_workplace(tx, id).await?;
                let (closed_on, previous, previous_since): (
                    Option<time::Date>,
                    Option<Uuid>,
                    Option<time::Date>,
                ) = sqlx::query_as(
                    "SELECT closed_on, head_employee_id, head_since FROM workplaces WHERE id = $1",
                )
                .bind(id)
                .fetch_one(tx.as_mut())
                .await?;
                if closed_on.is_some() && cmd.head_employee_id.is_some() {
                    return Err(Refusal::conflict(
                        "workplace_closed",
                        "cannot appoint a head on a closed workplace",
                    )
                    .into());
                }
                if let Some(emp) = cmd.head_employee_id
                    && !crate::org_details::head_available(tx, emp).await?
                {
                    return Err(Refusal::field("head_employee_id", "head_unavailable").into());
                }
                let today = today_kst(tx).await?;
                let head_since = match cmd.head_employee_id {
                    None => None,
                    Some(emp) if Some(emp) == previous => previous_since.or(Some(today)),
                    Some(_) => Some(today),
                };
                sqlx::query(
                    "UPDATE workplaces SET head_employee_id = $2, head_since = $3 WHERE id = $1",
                )
                .bind(id)
                .bind(cmd.head_employee_id)
                .bind(head_since)
                .execute(tx.as_mut())
                .await?;
                let event = audit(
                    &actor,
                    "workplace.head",
                    "workplace",
                    id,
                    admitted,
                    json!({
                        "head_employee_id": cmd.head_employee_id,
                        "previous": previous,
                    }),
                )?;
                let mode: String = admitted.mode.as_str().into();
                finish(
                    tx,
                    &actor,
                    &Outcome {
                        target: Some(id),
                        change_mode: Some(mode.clone()),
                        count: None,
                    },
                )
                .await?;
                let record = one_view(tx, entity, id, today).await?;
                Ok((
                    Saved {
                        record,
                        warnings: Vec::new(),
                        change_mode: mode,
                    },
                    vec![event],
                ))
            })
        })
        .await
    }
}
