//! UX-R1 ACCESS (governance-01, governance-22, company-17): an invite carries no access, no one mints a preset role,
//! and the tenant ops account is protected. A child of `org_setup` (its harness and seeds), kept apart so the pinned
//! parent file does not grow.

use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_invite_with_a_preset_role_or_branch_is_refused_and_writes_nothing(pool: PgPool) {
    // governance-01 (regression: 201 on 99dafebc): no preset roles, no
    // title-implied access; an invite carries no access at all.
    let harness = Harness::new(pool.clone()).await;
    let admin_branch = seed_branch(&pool).await;
    let ops = seed_user(&pool, "Ops", &["SUPER_ADMIN"], None).await;
    let token = harness.token(ops, &["SUPER_ADMIN"], vec![]).await;
    for (body, code) in [
        (
            json!({ "display_name": "임원", "roles": ["EXECUTIVE"] }),
            "preset_role_refused",
        ),
        (
            json!({ "display_name": "임원", "roles": ["MEMBER"], "branch_ids": [admin_branch.to_string()] }),
            "preset_role_refused",
        ),
        (
            json!({ "display_name": "임원", "branch_ids": [admin_branch.to_string()] }),
            "branch_membership_refused",
        ),
    ] {
        let (status, refused) = send(&harness, "POST", "/api/v1/users", &token, Some(body)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused:?}");
        assert_eq!(refused["error"]["code"], code);
    }
    let written: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE display_name = '임원'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(written, 0, "nothing written");
    let audited: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = 'user.create'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audited, 0, "no user.create audit row");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn adding_a_preset_role_is_refused_even_with_a_receipt(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let admin_branch = seed_branch(&pool).await;
    let admin = seed_user(&pool, "Branch Admin", &["ADMIN"], Some(admin_branch)).await;
    let executive = seed_user(&pool, "임원", &["EXECUTIVE"], Some(admin_branch)).await;
    let token = harness.token(admin, &["ADMIN"], vec![admin_branch]).await;

    let (status, preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{executive}/assignment-preview"),
        &token,
        Some(json!({
            "system_roles": ["EXECUTIVE", "ADMIN"],
            "branch_ids": [admin_branch.to_string()],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview:?}");
    let preview_receipt_id = preview["preview_receipt_id"].as_str().unwrap();

    let (status, refused) = send_patch(
        &harness,
        &format!("/api/v1/users/{executive}"),
        &token,
        json!({
            "roles": ["EXECUTIVE", "ADMIN"],
            "branch_ids": [admin_branch.to_string()],
            "preview_acknowledged": true,
            "preview_receipt_id": preview_receipt_id,
        }),
    )
    .await;
    // governance-01: a role is never added again, even with a receipt.
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused:?}");
    assert_eq!(refused["error"]["code"], "preset_role_refused");
    assert_eq!(
        persisted_user_roles(&pool, executive).await,
        vec!["EXECUTIVE"]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn even_the_ops_account_cannot_mint_a_preset_role(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    // SUPER_ADMIN resolves to BranchScope::All; no branch membership needed.
    let super_admin = seed_user(&pool, "Cold Start Admin", &["SUPER_ADMIN"], None).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]).await;

    let (status, user) = send(
        &harness,
        "POST",
        "/api/v1/users",
        &token,
        Some(json!({
            "display_name": "이임원",
            "roles": ["EXECUTIVE"],
            "branch_ids": [],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{user:?}");
    assert_eq!(user["error"]["code"], "preset_role_refused");
}

/// governance-22 (regression: 400 bad_request on 99dafebc): the ops account is
/// never deactivated nor given a role — by itself or anyone — and the refusal is
/// a typed code; nothing changes. Self-deactivation is typed too.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_ops_account_is_protected_with_a_typed_refusal(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let existing: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE org_id = $1 AND is_tenant_ops")
            .bind(*OrgId::one().as_uuid())
            .fetch_optional(&pool)
            .await
            .unwrap();
    let ops = match existing {
        Some(id) => UserId::from_uuid(id),
        None => {
            let ops = seed_user(&pool, "운영 계정", &["SUPER_ADMIN"], None).await;
            sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
                .bind(*ops.as_uuid())
                .execute(&pool)
                .await
                .unwrap();
            ops
        }
    };
    let other = seed_user(&pool, "권한 관리 담당", &["SUPER_ADMIN"], None).await;
    for actor in [ops, other] {
        let token = harness.token(actor, &["SUPER_ADMIN"], vec![]).await;
        let (status, body) = send(
            &harness,
            "POST",
            &format!("/api/v1/users/{ops}/deactivate"),
            &token,
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body:?}");
        assert_eq!(body["error"]["code"], "ops_account_protected");
        let (status, body) = send_patch(
            &harness,
            &format!("/api/v1/users/{ops}"),
            &token,
            json!({ "roles": [] }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body:?}");
        assert_eq!(body["error"]["code"], "ops_account_protected");
    }
    let (active, roles): (bool, Vec<String>) =
        sqlx::query_as("SELECT is_active, roles FROM users WHERE id = $1")
            .bind(*ops.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(active, "still active");
    assert_eq!(roles, vec!["SUPER_ADMIN"], "roles unchanged");
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'user.deactivate' AND target_id = $1",
    )
    .bind(ops.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audited, 0, "nothing written");

    // Anyone's own account: typed, not a generic 400.
    let token = harness.token(other, &["SUPER_ADMIN"], vec![]).await;
    let (status, body) = send(
        &harness,
        "POST",
        &format!("/api/v1/users/{other}/deactivate"),
        &token,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body:?}");
    assert_eq!(body["error"]["code"], "own_account_refused");
}
