//! The lifecycle transition log orders by append, not by clock (migration 0270).
//!
//! Every transition below runs in ONE transaction, so all five rows share one
//! `occurred_at` (`now()` is the transaction start). Ordered by `occurred_at`
//! with a random-UUID tie-break, the log came back in an arbitrary order; the
//! `seq` column orders it exactly as the rows were appended.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::OrgId;
use console_platform_db::{lifecycle, with_org_conn};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::macros::date;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn seed_user(owner_pool: &PgPool, org: Uuid, display_name: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (org_id, display_name, roles) VALUES ($1, $2, ARRAY['ADMIN']) \
         RETURNING id",
    )
    .bind(org)
    .bind(display_name)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn transitions_in_one_transaction_list_newest_first(owner_pool: PgPool) {
    let org = *OrgId::one().as_uuid();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, 'org-a', 'Org A') \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .execute(&owner_pool)
    .await
    .unwrap();
    let maker = seed_user(&owner_pool, org, "기안자").await;
    let checker = seed_user(&owner_pool, org, "승인자").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let object_id = Uuid::new_v4();

    let log =
        with_org_conn::<_, _, console_platform_db::DbError>(&rt_pool, OrgId::one(), move |tx| {
            Box::pin(async move {
                let mut lifecycle_id = Uuid::nil();
                for (to_state, actor) in [
                    ("submitted", maker),
                    ("approved", checker),
                    ("active", checker),
                    ("revised", maker),
                    ("archived", maker),
                ] {
                    let record = lifecycle::transition_lifecycle(
                        tx,
                        org,
                        "document",
                        object_id,
                        to_state,
                        Some(actor),
                        "정상 전이",
                        date!(2026 - 07 - 09),
                    )
                    .await
                    .unwrap_or_else(|e| panic!("transition to {to_state} must succeed: {e:?}"));
                    lifecycle_id = record.id;
                }
                lifecycle::list_transitions(tx, lifecycle_id).await
            })
        })
        .await
        .unwrap();

    let order: Vec<&str> = log.iter().map(|t| t.to_state.as_str()).collect();
    assert_eq!(
        order,
        ["archived", "revised", "active", "approved", "submitted"]
    );
    assert!(
        log.windows(2).all(|w| w[0].occurred_at == w[1].occurred_at),
        "the rows share one occurred_at, so only seq can order them"
    );
}
