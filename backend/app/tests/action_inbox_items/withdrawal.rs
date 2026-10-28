// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{http, org_change};
use ::http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn drafter_withdraws_in_approval_without_a_current_grant(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["MEMBER"]).await;
    let (id, steps) = org_change::request(&pool, org, maker).await;
    let ctx = http::ctx(&pool, org, maker, &["MEMBER"], None).await;
    let before = org_change::snapshot(&pool, id).await;
    let (status, body) = ctx
        .call(
            "POST",
            &format!("/api/v1/org-changes/{id}/cancel"),
            Some(json!({"reason":"결재자 추가 후 다시 상신"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "CANCELLED");
    let after = org_change::snapshot(&pool, id).await;
    assert_eq!(
        after[1], before[1],
        "the stored chain is evidence, never erased"
    );
    assert_eq!(after[2], before[2], "withdrawal creates no approval");
    assert_eq!(after[3].as_i64(), Some(before[3].as_i64().unwrap() + 1));
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action='org_change.cancel' AND target_id=$1",
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);
    // A later decision sees withdrawal before the supplied stale version.
    let checker = org_change::actor(&pool, org).await;
    super::person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let checker_ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let (status, body) = checker_ctx
        .call(
            "POST",
            &org_change::path(id, steps[0]),
            Some(json!({"decision":"APPROVED","expected_version":"stale"})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    super::contract::assert_decision_error(&body);
    assert_eq!(body["error"]["code"], "lifecycle.refuse.withdrawn");
    assert_eq!(org_change::snapshot(&pool, id).await, after);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_the_drafter_withdraws_even_with_higher_authority(pool: PgPool) {
    let (org, ops) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let maker = http::add_user(&pool, org, &["MEMBER"]).await;
    let lower = http::add_user(&pool, org, &["MEMBER"]).await;
    let (id, _) = org_change::request(&pool, org, maker).await;
    for (actor, role) in [(ops, "SUPER_ADMIN"), (lower, "MEMBER")] {
        let ctx = http::ctx(&pool, org, actor, &[role], None).await;
        let before = org_change::snapshot(&pool, id).await;
        let (status, body) = ctx
            .call(
                "POST",
                &format!("/api/v1/org-changes/{id}/cancel"),
                Some(json!({"reason":"다른 사람의 상신 회수"})),
            )
            .await;
        let (expected, code) = if actor == lower {
            (StatusCode::NOT_FOUND, "org_change.refuse.missing_grant")
        } else {
            (StatusCode::FORBIDDEN, "org_change.refuse.not_drafter")
        };
        assert_eq!(status, expected, "{body}");
        assert_eq!(body["error"]["code"], code);
        assert!(
            body["error"]["support_ref"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        assert_eq!(org_change::snapshot(&pool, id).await, before);
    }
    let (foreign_org, foreign) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, foreign_org, foreign, &["SUPER_ADMIN"], None).await;
    let before = org_change::snapshot(&pool, id).await;
    for target in [id, uuid::Uuid::new_v4()] {
        let (status, _) = ctx
            .call(
                "POST",
                &format!("/api/v1/org-changes/{target}/cancel"),
                Some(json!({"reason":"회수"})),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    assert_eq!(org_change::snapshot(&pool, id).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn withdrawal_preserves_partial_decisions_and_rejects_empty_reason(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    super::person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let checker = org_change::actor(&pool, org).await;
    let (id, steps) = org_change::request(&pool, org, maker).await;
    let checker_ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    assert_eq!(
        checker_ctx
            .call(
                "POST",
                &org_change::path(id, steps[0]),
                Some(json!({"decision":"APPROVED"}))
            )
            .await
            .0,
        StatusCode::OK
    );
    let ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    let before = org_change::snapshot(&pool, id).await;
    let (status, _) = ctx
        .call(
            "POST",
            &format!("/api/v1/org-changes/{id}/cancel"),
            Some(json!({"reason":" "})),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(org_change::snapshot(&pool, id).await, before);
    let (status, body) = ctx
        .call(
            "POST",
            &format!("/api/v1/org-changes/{id}/cancel"),
            Some(json!({"reason":"계획 변경으로 회수"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "CANCELLED");
    let after = org_change::snapshot(&pool, id).await;
    assert_eq!(after[1], before[1]);
    assert_eq!(after[2], before[2]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn withdrawal_does_not_grant_a_member_authority_to_cancel_drafts(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["MEMBER"]).await;
    let (id, _) = org_change::request(&pool, org, maker).await;
    sqlx::query("UPDATE org_change_requests SET status='DRAFT' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let ctx = http::ctx(&pool, org, maker, &["MEMBER"], None).await;
    let before = org_change::snapshot(&pool, id).await;
    let (status, body) = ctx
        .call(
            "POST",
            &format!("/api/v1/org-changes/{id}/cancel"),
            Some(json!({"reason":"초안 취소"})),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "org_change.refuse.missing_grant");
    assert_eq!(org_change::snapshot(&pool, id).await, before);
}
