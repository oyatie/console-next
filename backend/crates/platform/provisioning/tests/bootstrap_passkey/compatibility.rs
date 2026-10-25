// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_platform_test_support::MIGRATOR;

async fn apply_identity_migration(pool: &PgPool) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../db/migrations/20261025010000003_platform_admin_identity.sql"
    ))
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

// These are the non-null readers shipped in 1c7665148, before nullable-name support.
async fn previous_binary_reads(pool: &PgPool, id: Uuid) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(OrgId::platform().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let display_name: String = sqlx::query_scalar(
        "SELECT u.display_name FROM person_accounts_current u \
         JOIN users account ON account.org_id=u.org_id AND account.id=u.id WHERE u.id=$1",
    )
    .bind(id)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert!(!display_name.trim().is_empty());
    let (login, label): (String, String) = sqlx::query_as(
        "SELECT s.login || '@' || o.slug, u.display_name || ' · ' || o.name || ' — ' || s.login || '@' || o.slug \
         FROM user_sign_in_ids s JOIN organizations o ON o.id=s.org_id \
         JOIN person_accounts_current u ON u.id=s.user_id AND u.org_id=s.org_id \
         WHERE s.user_id=$1 AND s.retired_at IS NULL",
    )
    .bind(id)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert!(label.contains(&display_name) && label.contains(&login));
    tx.commit().await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn migration_preserves_existing_names_and_previous_binary_sign_in(pool: PgPool) {
    MIGRATOR.run_to(20261025010000002, &pool).await.unwrap();
    let admin: Uuid = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&pool)
        .await
        .unwrap();
    for (org, name) in [
        (OrgId::platform(), "박관리자"),
        (OrgId::one(), "Cold Start Admin"),
    ] {
        sqlx::query(
            "INSERT INTO users(org_id,display_name,roles,id) VALUES($1,$2,ARRAY['SUPER_ADMIN'],$3)",
        )
        .bind(org.as_uuid())
        .bind(name)
        .bind(if org == OrgId::platform() {
            Uuid::from_u128(u128::MAX)
        } else {
            Uuid::new_v4()
        })
        .execute(&pool)
        .await
        .unwrap();
    }
    let snapshot = "SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u";
    let before: serde_json::Value = sqlx::query_scalar(snapshot).fetch_one(&pool).await.unwrap();
    apply_identity_migration(&pool).await;
    let after: serde_json::Value = sqlx::query_scalar(snapshot).fetch_one(&pool).await.unwrap();
    assert_eq!(
        before, after,
        "release N must not rewrite any existing account"
    );
    previous_binary_reads(&pool, admin).await;
    // N-1's name lookup must still find the seeded operator after the migration.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(OrgId::platform().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let previous_admin: Uuid = sqlx::query_scalar(
        "SELECT id FROM users WHERE display_name='Cold Start Admin' \
         AND roles @> ARRAY['SUPER_ADMIN']::TEXT[] ORDER BY id LIMIT 1 FOR UPDATE",
    )
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(previous_admin, admin);
    tx.commit().await.unwrap();
    let now = OffsetDateTime::now_utc();
    assert!(
        BootstrapCredentialStore
            .seed_cold_start_credential(&pool, "n1-upgrade", Duration::hours(1), now)
            .await
            .unwrap()
    );
    assert_eq!(
        BootstrapCredentialStore
            .redeem_otp(&pool, "n1-upgrade", now)
            .await
            .unwrap()
            .user_id,
        admin
    );
}

#[sqlx::test(migrations = false)]
async fn fresh_operator_has_a_real_identifier_label_and_keeps_not_null(pool: PgPool) {
    MIGRATOR.run_to(20261025010000002, &pool).await.unwrap();
    apply_identity_migration(&pool).await;
    sqlx::query("DELETE FROM users WHERE org_id=$1 AND roles @> ARRAY['SUPER_ADMIN']::text[]")
        .bind(OrgId::platform().as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let admin: Uuid = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&pool)
        .await
        .unwrap();
    previous_binary_reads(&pool, admin).await;
    let (name, identifier): (String, String) = sqlx::query_as(
        "SELECT u.display_name,s.login || '@' || o.slug FROM users u \
         JOIN user_sign_in_ids s ON s.user_id=u.id AND s.org_id=u.org_id AND s.retired_at IS NULL \
         JOIN organizations o ON o.id=u.org_id WHERE u.id=$1",
    )
    .bind(admin)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        name, identifier,
        "new installs use the actual account identifier, never a placeholder name"
    );
    let not_null: bool = sqlx::query_scalar(
        "SELECT attnotnull FROM pg_attribute WHERE attrelid='users'::regclass AND attname='display_name'",
    ).fetch_one(&pool).await.unwrap();
    assert!(
        not_null,
        "release N retains the previous binary's schema contract"
    );
    let now = OffsetDateTime::now_utc();
    assert!(
        BootstrapCredentialStore
            .seed_cold_start_credential(&pool, "n1-fresh", Duration::hours(1), now)
            .await
            .unwrap()
    );
    assert_eq!(
        BootstrapCredentialStore
            .redeem_otp(&pool, "n1-fresh", now)
            .await
            .unwrap()
            .user_id,
        admin
    );
}
