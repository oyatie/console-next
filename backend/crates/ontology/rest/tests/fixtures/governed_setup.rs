// SPDX-License-Identifier: LicenseRef-Proprietary
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
#[path = "../../../adapter-postgres/tests/fixtures/verified_user.rs"]
mod users;
pub(super) use console_platform_test_support::runtime_role_pool;
pub(super) use users::seed_org_and_user as seed_org_and_super_admin;

/// The command pool. Without it every object-TYPE write is 503
/// `ontology_command_unavailable` — the same failure a deployment that never
/// sets `ONTOLOGY_COMMAND_DATABASE_URL` would produce.
pub(super) async fn command_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_ontology_cmd")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}
