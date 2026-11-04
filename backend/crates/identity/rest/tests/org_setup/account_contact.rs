// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn renaming_platform_root_through_me_never_creates_another_admin(pool: PgPool) {
    use console_kernel_core::{OrgId, UserId};
    let harness = Harness::new(pool.clone()).await;
    let root: uuid::Uuid = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut input = harness.access_token_input_for_org(
        OrgId::platform(),
        UserId::from_uuid(root),
        &["SUPER_ADMIN"],
        vec![],
    );
    input.platform = true;
    let token = console_platform_test_support::issue_session_token(
        &harness.pool,
        &harness.issuer(),
        input,
        None,
        vec![],
    )
    .await;
    let (status, before) = send(&harness, "GET", "/api/platform/users/me", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{before:?}");
    let existing_name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
        .bind(root)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before["display_name"], existing_name);
    assert!(before.get("name_unset").is_none());
    let (status, after) = send(
        &harness,
        "PATCH",
        "/api/platform/users/me",
        &token,
        Some(json!({"display_name": "박관리자"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{after:?}");
    assert_eq!(after["display_name"], "박관리자");
    assert!(after.get("name_unset").is_none());
    let (invalid, _) = send(
        &harness,
        "PATCH",
        "/api/platform/users/me",
        &token,
        Some(json!({"display_name":"   "})),
    )
    .await;
    assert_eq!(invalid, StatusCode::UNPROCESSABLE_ENTITY);
    let reseeded: uuid::Uuid = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(reseeded, root);
    let (status, _) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users WHERE org_id=$1 AND roles @> ARRAY['SUPER_ADMIN']::text[]",
    )
    .bind(OrgId::platform().as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_token_cannot_read_or_patch_the_platform_profile(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let me = seed_user(&pool, "김관리자", &["SUPER_ADMIN"], None).await;
    let token = harness.token(me, &["SUPER_ADMIN"], vec![]).await;
    for method in ["GET", "PATCH"] {
        let (status, _) = send(
            &harness,
            method,
            "/api/platform/users/me",
            &token,
            (method == "PATCH").then(|| json!({"display_name":"탈취"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}

async fn reader(pool: &PgPool) -> (Harness, UserId, UserId) {
    let h = Harness::new(pool.clone()).await;
    let actor = seed_user(pool, "권한 조회자", &[], None).await;
    let target = seed_user(pool, "계정", &[], None).await;
    let role = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'권한 조회','ACTIVE',1,$3)")
        .bind(OrgId::one().as_uuid()).bind(role).bind(target.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'권한 조회','ACTIVE','SETUP',$3)")
        .bind(OrgId::one().as_uuid()).bind(role).bind(target.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'access',ARRAY['view'])")
        .bind(OrgId::one().as_uuid()).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now() - interval '1 hour',true,'SETUP','INITIAL',$4)")
        .bind(OrgId::one().as_uuid()).bind(actor.as_uuid()).bind(role).bind(target.as_uuid()).execute(pool).await.unwrap();
    (h, actor, target)
}

async fn get(h: &Harness, actor: UserId, target: UserId) -> (StatusCode, Value) {
    let token = h.token(actor, &[], vec![]).await;
    send(
        h,
        "GET",
        &format!("/api/v1/access/people/{target}"),
        &token,
        None,
    )
    .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_reader_gets_linked_summary_and_records_access(pool: PgPool) {
    let (h, actor, target) = reader(&pool).await;
    let employee = seed_employee_link(&pool, target, "ACCESS-001", "김직원").await;
    let (status, body) = get(&h, actor, target).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["id"], target.to_string());
    assert_eq!(body["employee_id"], employee.to_string());
    assert_eq!(body["employee_number"], "ACCESS-001");
    assert_eq!(body["employee_name"], "김직원");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action='account.read' AND actor=$1 AND target_id=$2")
        .bind(actor.as_uuid()).bind(target.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn access_view_only_reader_gets_no_contact_or_unshown_account_fields(pool: PgPool) {
    let (h, actor, target) = reader(&pool).await;
    sqlx::query("UPDATE users SET phone='+821055550000' WHERE id=$1")
        .bind(target.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = get(&h, actor, target).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        body.get("phone").is_none(),
        "contact must be absent: {body}"
    );
    let allowed = [
        "id",
        "display_name",
        "sign_in_id",
        "employee_id",
        "employee_name",
        "employee_number",
        "employee_company",
        "employee_org_unit",
        "employee_link_status",
        "roles",
        "branch_ids",
        "is_active",
        "is_tenant_ops",
        "has_passkey",
        "account_status",
    ]
    .into_iter()
    .collect::<std::collections::BTreeSet<_>>();
    let keys = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(keys, allowed, "access detail is a closed projection");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_refuses_ungranted_and_legacy_admin_readers_before_lookup(pool: PgPool) {
    let h = Harness::new(pool.clone()).await;
    let target = seed_user(&pool, "계정", &[], None).await;
    for roles in [vec![], vec!["SUPER_ADMIN"]] {
        let actor = seed_user(&pool, "조회자", &roles, None).await;
        let token = h.token(actor, &roles, vec![]).await;
        for id in [target, UserId::new()] {
            let (status, body) = send(
                &h,
                "GET",
                &format!("/api/v1/access/people/{id}"),
                &token,
                None,
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            assert_eq!(body["error"]["code"], "access_denied");
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_reader_gets_not_found_for_missing_and_foreign_accounts(pool: PgPool) {
    let (h, actor, _) = reader(&pool).await;
    let foreign = OrgId::new();
    seed_org(&pool, foreign, "other-access").await;
    let target = seed_user_in_org_with_team(&pool, foreign, "다른 계정", &[], None, None).await;
    for id in [UserId::new(), target] {
        let (status, body) = get(&h, actor, id).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"]["code"], "not_found");
        assert!(body.get("id").is_none());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_reads_unlinked_account_without_legacy_roles(pool: PgPool) {
    let h = Harness::new(pool.clone()).await;
    let ops = seed_user(&pool, "운영 계정", &[], None).await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(ops.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let target = seed_user(&pool, "계정", &[], None).await;
    let (status, body) = get(&h, ops, target).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["employee_link_status"], "UNLINKED");
    assert!(body["employee_id"].is_null());
}
