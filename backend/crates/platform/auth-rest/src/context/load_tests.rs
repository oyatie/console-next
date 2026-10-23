// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::load_user_auth_context_in_org;
use console_kernel_core::OrgId;
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn username_fallback_uses_the_account_contact_and_keeps_the_person_name(pool: PgPool) {
    let org = OrgId::new();
    let user = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO organizations(id,slug,name,status) VALUES($1,$2,'Contact auth','ACTIVE')",
    )
    .bind(org.as_uuid())
    .bind(org.to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users(id,org_id,display_name,phone) VALUES($1,$2,'Account','+821012345678')",
    )
    .bind(user)
    .bind(org.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("SELECT console_revise_person_facts(org_id,person_id,'{\"display_name\":\"Human\",\"phone\":\"+82212345678\"}'::jsonb,NULL) FROM users WHERE id=$1")
        .bind(user).execute(&pool).await.unwrap();
    let rt = runtime_role_pool(&pool).await;
    let context = load_user_auth_context_in_org(&rt, org, user).await.unwrap();
    assert_eq!(context.display_name, "Human");
    assert_eq!(context.username, "+821012345678");
    sqlx::query("UPDATE users SET phone=NULL WHERE id=$1")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let context = load_user_auth_context_in_org(&rt, org, user).await.unwrap();
    assert_eq!(context.username, user.to_string());
}
