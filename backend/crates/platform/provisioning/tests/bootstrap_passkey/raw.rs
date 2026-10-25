// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[path = "compatibility.rs"]
mod compatibility;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn platform_admin_rejects_null_and_blank_names(pool: PgPool) {
    let admin: Uuid = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let null = sqlx::query("UPDATE users SET display_name=NULL WHERE id=$1")
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        null.as_database_error().unwrap().code().as_deref(),
        Some("23502")
    );
    for blank in ["", "   "] {
        let error = sqlx::query("UPDATE users SET display_name=$2 WHERE id=$1")
            .bind(admin)
            .bind(blank)
            .execute(&pool)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
    }
    let tenant_null = sqlx::query("INSERT INTO users (org_id,display_name) VALUES ($1,NULL)")
        .bind(OrgId::one().as_uuid())
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        tenant_null.as_database_error().unwrap().code().as_deref(),
        Some("23502")
    );
}

/// A display name is editable; it must never determine the platform root's identity.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn renamed_platform_admin_is_reused_at_boot(pool: PgPool) {
    let platform = *OrgId::platform().as_uuid();
    let admin: Uuid = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET display_name='박관리자' WHERE id=$1")
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap();
    BootstrapCredentialStore
        .seed_cold_start_credential(
            &pool,
            "renamed-root-test",
            Duration::hours(1),
            OffsetDateTime::now_utc(),
        )
        .await
        .unwrap();
    let admins: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE org_id=$1 AND roles @> ARRAY['SUPER_ADMIN']::text[]",
    )
    .bind(platform)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(admins, vec![admin]);
    let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
        .bind(admin)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "박관리자");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_with_the_legacy_name_is_never_the_platform_root(pool: PgPool) {
    let tenant: Uuid = sqlx::query_scalar("INSERT INTO users (display_name,roles,org_id) VALUES ('Cold Start Admin',ARRAY['SUPER_ADMIN'], $1) RETURNING id")
        .bind(OrgId::one().as_uuid()).fetch_one(&pool).await.unwrap();
    let admin: Uuid = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(admin, tenant);
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(admin)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(org, *OrgId::platform().as_uuid());
}
