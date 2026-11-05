// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invited_approver_receives_work_even_when_identity_verification_blocks_decision(
    pool: PgPool,
) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let checker = http::add_user(&pool, org, &["ADMIN"]).await;
    grants::grant_org_approve(&pool, checker).await;
    grants::grant_org_approve(&pool, maker).await;
    let id = document(&pool, org, maker, "OC-2026-0001").await;
    let ctx = http::ctx(&pool, org, checker, &["ADMIN"], None).await;
    let maker_ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    assert_eq!(get(&maker_ctx, "box=pending").await["counts"]["pending"], 0);
    let page = get(&ctx, "box=pending").await;
    assert_eq!(
        page["counts"]["pending"], 1,
        "a decision refusal must not silently drop work"
    );
    assert_eq!(page["items"][0]["id"], format!("org_change:{id}"));
    assert_eq!(
        page["items"][0]["decision_refusal"],
        "org_change.refuse.identity_unbound"
    );
    let (status, inbox) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{inbox}");
    assert!(
        inbox["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == format!("org_change:{id}"))
    );
    let step: Uuid = sqlx::query_scalar(
        "SELECT id FROM org_change_approval_steps WHERE request_id=$1 AND step_order=1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (status, refusal) = ctx
        .call(
            "POST",
            &format!("/api/v1/org-changes/{id}/approval-steps/{step}/decision"),
            Some(json!({"decision":"APPROVED"})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refusal}");
    assert_eq!(
        refusal["error"]["code"],
        "org_change.refuse.identity_unbound"
    );
    let decision: String =
        sqlx::query_scalar("SELECT decision FROM org_change_approval_steps WHERE id=$1")
            .bind(step)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(decision, "PENDING");
    for user in [maker, checker] {
        people::bind_user_to_distinct_person(&pool, user).await;
    }
    assert!(get(&ctx, "box=pending").await["items"][0]["decision_refusal"].is_null());
    let (status, result) = ctx
        .call(
            "POST",
            &format!("/api/v1/org-changes/{id}/approval-steps/{step}/decision"),
            Some(json!({"decision":"APPROVED"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(get(&ctx, "box=pending").await["counts"]["pending"], 0);
}
