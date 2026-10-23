// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{Harness, seed_employee_link, seed_user, send};
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn any_authenticated_user_edits_own_account_contact_without_replacing_person_phone(
    pool: PgPool,
) {
    let harness = Harness::new(pool.clone()).await;
    let me = seed_user(&pool, "Cold Start Admin", &["SUPER_ADMIN"], None).await;
    let token = harness.token(me, &["SUPER_ADMIN"], vec![]).await;
    sqlx::query("SELECT console_revise_person_facts(org_id,person_id,'{\"phone\":\"+82212345678\"}'::jsonb,NULL) FROM users WHERE id=$1")
        .bind(me.as_uuid()).execute(&pool).await.unwrap();
    let (status, before) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{before:?}");
    assert_eq!(before["display_name"], "Cold Start Admin");
    let (status, after) = send(
        &harness,
        "PATCH",
        "/api/v1/users/me",
        &token,
        Some(json!({ "display_name": "박관리자", "phone": "010-9999-0000" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{after:?}");
    assert_eq!(after["display_name"], "박관리자");
    assert_eq!(
        after["phone"], "+821099990000",
        "PATCH must echo the account contact"
    );
    let contact: Option<String> = sqlx::query_scalar("SELECT phone FROM users WHERE id=$1")
        .bind(me.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(contact.as_deref(), Some("+821099990000"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn linked_account_get_after_patch_returns_its_own_contact(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let actor = seed_user(&pool, "Admin", &["SUPER_ADMIN"], None).await;
    let target = seed_user(&pool, "Account", &["MEMBER"], None).await;
    let employee = seed_employee_link(&pool, target, "CONTACT-001", "김직원").await;
    sqlx::query("SELECT console_revise_person_facts(org_id,person_id,'{\"phone\":\"+82212345678\"}'::jsonb,NULL) FROM users WHERE id=$1")
        .bind(target.as_uuid()).execute(&pool).await.unwrap();
    let token = harness.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let path = format!("/api/v1/users/{target}");
    let (status, patched) = send(
        &harness,
        "PATCH",
        &path,
        &token,
        Some(json!({"phone":"010-5555-0000"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{patched:?}");
    assert_eq!(patched["phone"], "+821055550000");
    let (status, got) = send(&harness, "GET", &path, &token, None).await;
    assert_eq!(status, StatusCode::OK, "{got:?}");
    assert_eq!(got["phone"], "+821055550000");
    assert_eq!(got["employee_id"], employee.to_string());
    let person_phone: String = sqlx::query_scalar(
        "SELECT console_person_facts(org_id,person_id)->>'phone' FROM users WHERE id=$1",
    )
    .bind(target.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(person_phone, "+82212345678");
}
