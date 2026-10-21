use crate::{PgEntityError, PgEntityStore, read, today_kst};
use console_entity_application::{Actor, LegalEntityView, ReadOptions, ReadPoint, WorkplaceView};
use console_entity_domain::Refusal;
use console_platform_db::with_org_snapshot;
use uuid::Uuid;

impl PgEntityStore {
    /// # Errors
    /// Database faults; records remain filtered by the current caller's scope.
    pub async fn list_entities_at(
        &self,
        actor: &Actor,
        personal: bool,
        q: ReadOptions,
    ) -> Result<Vec<LegalEntityView>, PgEntityError> {
        let granted = actor.scope.granted().map(<[Uuid]>::to_vec);
        with_org_snapshot(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let point = ReadPoint::new(today_kst(tx).await?, q);
                read::entities_at(tx, None, granted.as_deref(), personal, point).await
            })
        })
        .await
    }

    /// # Errors
    /// Scoped not-found or database faults.
    pub async fn get_entity_at(
        &self,
        actor: &Actor,
        id: Uuid,
        personal: bool,
        q: ReadOptions,
    ) -> Result<LegalEntityView, PgEntityError> {
        let granted = actor.scope.granted().map(<[Uuid]>::to_vec);
        with_org_snapshot(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let point = ReadPoint::new(today_kst(tx).await?, q);
                let entities =
                    read::entities_at(tx, Some(id), granted.as_deref(), personal, point).await?;
                entities
                    .into_iter()
                    .next()
                    .ok_or_else(|| Refusal::not_found("legal_entity_not_found").into())
            })
        })
        .await
    }

    /// # Errors
    /// Scoped not-found or database faults.
    pub async fn get_workplace_at(
        &self,
        actor: &Actor,
        id: Uuid,
        personal: bool,
        q: ReadOptions,
    ) -> Result<WorkplaceView, PgEntityError> {
        self.list_entities_at(actor, personal, q)
            .await?
            .into_iter()
            .flat_map(|e| e.workplaces)
            .find(|w| w.id == id)
            .ok_or_else(|| Refusal::not_found("workplace_not_found").into())
    }
}
