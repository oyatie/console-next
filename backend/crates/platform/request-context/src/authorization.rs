// SPDX-License-Identifier: LicenseRef-Proprietary
//! One immutable Cedar fact snapshot, including failures, per inbox read.
use console_kernel_core::{KernelError, OrgId};
use console_platform_authz::Principal;
use console_platform_authz::cedar_pbac::visible::{DecisionFacts, load_facts_with_access};
use console_platform_db::{DbError, with_org_conn};
use sqlx::{PgPool, Postgres, Transaction};
use std::sync::Arc;
use tokio::sync::OnceCell;
use uuid::Uuid;

#[derive(Debug, Clone, Default)]
pub struct Authorization(Arc<OnceCell<Result<Arc<DecisionFacts>, KernelError>>>);

impl Authorization {
    /// Prepare common facts before source budgets; each source still reports its failures.
    pub async fn prepare(&self, pool: &PgPool, principal: &Principal) {
        let (org, actor) = (principal.org_id, *principal.user_id.as_uuid());
        let authorization = self.clone();
        let _ = with_org_conn(pool, org, move |tx| {
            Box::pin(async move { Ok::<_, DbError>(authorization.get_in(tx, org, actor).await) })
        })
        .await;
    }

    pub async fn get_in(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: OrgId,
        actor: Uuid,
    ) -> Result<Arc<DecisionFacts>, KernelError> {
        let facts = self
            .0
            .get_or_init(|| async {
                load_facts_with_access(tx, org, actor, crate::current_access_snapshot(org, actor))
                    .await
                    .map(Arc::new)
            })
            .await
            .clone()?;
        facts.access_permissions(org, actor)?;
        Ok(facts)
    }
}
