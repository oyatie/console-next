// SPDX-License-Identifier: LicenseRef-Proprietary
//! Registration deletion preview uses the same workplace links as the void command.

use console_entity_application::Actor;
use console_entity_domain::Refusal;
use console_kernel_core::TenantPhase;
use console_platform_db::with_org_conn;
use serde::Serialize;
use uuid::Uuid;

use crate::{EndOffer, PgEntityError, PgEntityStore, Tx, read_phase};

#[derive(Debug, Serialize)]
pub struct RegistrationEndOptions {
    pub id: Uuid,
    pub phase: &'static str,
    pub delete: EndOffer,
    pub revisions: i64,
    pub linked_workplaces: Vec<LinkedWorkplace>,
}

#[derive(Debug, Serialize)]
pub struct LinkedWorkplace {
    pub id: Uuid,
    pub name: String,
}

async fn linked_workplaces(
    tx: &mut Tx<'_>,
    id: Uuid,
) -> Result<Vec<LinkedWorkplace>, PgEntityError> {
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT w.id, COALESCE((SELECT r.name FROM workplace_revisions r \
         WHERE r.workplace_id = w.id ORDER BY r.effective_from > (now() AT TIME ZONE 'Asia/Seoul')::date, \
         abs(r.effective_from - (now() AT TIME ZONE 'Asia/Seoul')::date), r.version DESC LIMIT 1), w.id::text) \
         FROM workplaces w WHERE w.registration_id = $1 AND w.voided_at IS NULL ORDER BY w.id",
    )
    .bind(id)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name)| LinkedWorkplace { id, name })
        .collect())
}

impl PgEntityStore {
    /// The setup-only void, with its stored revision count and current workplace blockers.
    ///
    /// # Errors
    /// Missing, voided or out-of-scope registration, or database faults.
    pub async fn registration_end_options(
        &self,
        actor: &Actor,
        id: Uuid,
    ) -> Result<RegistrationEndOptions, PgEntityError> {
        let actor = actor.clone();
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let entity: Option<Uuid> = sqlx::query_scalar(
                    "SELECT e.id FROM business_registrations r \
                     JOIN legal_entities e ON e.id = r.legal_entity_id \
                     WHERE r.id = $1 AND r.voided_at IS NULL AND e.voided_at IS NULL \
                       AND ($2::uuid[] IS NULL OR e.id = ANY($2) OR EXISTS \
                         (SELECT 1 FROM workplaces w WHERE w.legal_entity_id = e.id AND w.id = ANY($2)))",
                )
                .bind(id)
                .bind(actor.scope.granted())
                .fetch_optional(tx.as_mut())
                .await?;
                let entity = entity.ok_or_else(|| Refusal::not_found("registration_not_found"))?;
                let phase = read_phase(tx, false).await?;
                let mut linked_workplaces = linked_workplaces(tx, id).await?;
                let refused = if phase != TenantPhase::Setup {
                    Some("phase_not_setup")
                } else if !linked_workplaces.is_empty() {
                    Some("record_in_use")
                } else {
                    None
                };
                if let Some(granted) = actor.scope.granted() {
                    linked_workplaces.retain(|w| granted.contains(&entity) || granted.contains(&w.id));
                }
                let revisions = sqlx::query_scalar(
                    "SELECT count(*) FROM business_registration_revisions WHERE registration_id = $1",
                )
                .bind(id)
                .fetch_one(tx.as_mut())
                .await?;
                Ok(RegistrationEndOptions {
                    id,
                    phase: phase.as_str(),
                    delete: EndOffer::from(refused),
                    revisions,
                    linked_workplaces,
                })
            })
        })
        .await
    }
}
