#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The ops backfill (access-model §11.2): per tenant, the earliest ACTIVE
//! administrator account becomes the ops account; an inactive or later one
//! does not, and a tenant with no administrator gets none. The migration is
//! found by name, so INTEG's renumbering does not break this test.

use console_platform_test_support::MIGRATOR;
use sqlx::PgPool;
use uuid::Uuid;

async fn user(pool: &PgPool, org: Uuid, roles: &[&str], active: bool, age_days: i32) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, is_active, created_at) \
         VALUES ('u', $1, $2, $3, now() - make_interval(days => $4)) RETURNING id",
    )
    .bind(roles)
    .bind(org)
    .bind(active)
    .bind(age_days)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = false)]
async fn the_earliest_active_administrator_of_each_tenant_becomes_ops(owner: PgPool) {
    let version = MIGRATOR
        .iter()
        .find(|m| m.description.contains("access ops account"))
        .expect("the ops-account migration")
        .version;
    MIGRATOR.run_to(version - 1, &owner).await.unwrap();
    let (org, bare) = (Uuid::new_v4(), Uuid::new_v4());
    for (id, slug) in [(org, "bf-a"), (bare, "bf-b")] {
        sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $2)")
            .bind(id)
            .bind(format!("{slug}-{}", &id.simple().to_string()[..8]))
            .execute(&owner)
            .await
            .unwrap();
    }
    let retired = user(&owner, org, &["SUPER_ADMIN"], false, 30).await;
    let first = user(&owner, org, &["SUPER_ADMIN"], true, 20).await;
    let later = user(&owner, org, &["SUPER_ADMIN"], true, 10).await;
    let staff = user(&owner, bare, &["ADMIN"], true, 40).await;
    MIGRATOR.run(&owner).await.unwrap();
    let flagged: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE is_tenant_ops ORDER BY id")
            .fetch_all(&owner)
            .await
            .unwrap();
    assert!(flagged.contains(&first));
    for other in [retired, later, staff] {
        assert!(!flagged.contains(&other));
    }
}
