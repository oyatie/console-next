//! The existing scheduler owns command recovery; clients only consume SSE.
use console_kernel_core::OrgId;
use sqlx::PgPool;
pub(crate) async fn tick(pool: &PgPool) {
    let orgs: Result<Vec<uuid::Uuid>, _> =
        sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok SECURITY DEFINER id-only discovery; recovery arms each tenant below
            .fetch_all(pool)
            .await;
    match orgs {
        Ok(orgs) => {
            for id in orgs {
                if let Err(error) = console_platform_db::command_outcomes::expire_abandoned(
                    pool,
                    OrgId::from_uuid(id),
                )
                .await
                {
                    tracing::warn!(%error,"command recovery failed");
                }
            }
        }
        Err(error) => tracing::warn!(%error,"command recovery discovery failed"),
    }
}
