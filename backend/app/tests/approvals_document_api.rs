// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/approvals.rs"]
mod fixtures;
#[path = "../../test-support/org_change_fixtures.rs"]
mod grants;
#[path = "support/http.rs"]
mod http;
#[path = "../../test-support/person_fixtures.rs"]
mod people;
use ::http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_source_prefix_cannot_alias_a_visible_document(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0001").await;
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let (status, document) = ctx
        .call("GET", &format!("/api/v1/approvals/org_change:{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{document}");
    for unavailable in [false, true] {
        if unavailable {
            // Unknown sources must be refused before loading the source projection.
            sqlx::query(
                "ALTER TABLE org_change_requests RENAME TO unavailable_org_change_requests",
            )
            .execute(&pool)
            .await
            .unwrap();
        }
        for prefix in ["governance", "unknown"] {
            let (status, body) = ctx
                .call("GET", &format!("/api/v1/approvals/{prefix}:{id}"), None)
                .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{prefix}: {body}");
            assert_eq!(body["error"]["code"], "not_found");
            assert_eq!(body["error"]["message"], "approval document not found");
            assert!(body.get("body").is_none());
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_read_without_inbox_membership_returns_not_found(pool: PgPool) {
    let (org, maker, _) = fixtures::setup(&pool).await;
    let ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    let (status, body) = ctx
        .call(
            "GET",
            &format!("/api/v1/approvals/org_change:{}", Uuid::new_v4()),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    assert_eq!(body["error"]["message"], "approval document not found");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn detail_uses_source_body_route_and_changes_fingerprint_with_source_facts(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0001").await;
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let uri = format!("/api/v1/approvals/org_change:{id}");
    let (status, first) = ctx.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["document_no"], "OC-2026-0001");
    assert_eq!(first["route"][0]["role_key"], "hr");
    assert_eq!(first["route"][0]["state"], "current");
    assert_eq!(
        first["body"][0],
        json!({"key":"target","label":"대상","value":"조직 개편"})
    );
    assert!(
        first["body"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["key"] == "reason" && f["value"] == "변경 검토")
    );
    assert_eq!(first["my_actions"], json!({"kind":"none"}));
    assert_eq!(first["opinion_max"], 0);
    assert!(!first["fingerprint"].as_str().unwrap().is_empty());
    assert!(first["revision"].as_u64().unwrap() > 0);
    assert_eq!(ctx.call("GET", &uri, None).await.1, first);
    let maker_ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    let own = maker_ctx.call("GET", &uri, None).await.1;
    assert_eq!(own["box"], "requested");
    assert_eq!(
        own["fingerprint"], first["fingerprint"],
        "a fingerprint describes source facts, not the actor's box"
    );
    // Even an edit without a timestamp change invalidates the seen document.
    sqlx::query("UPDATE org_change_requests SET reason='수정된 사유' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let changed = ctx.call("GET", &uri, None).await.1;
    assert_ne!(changed["fingerprint"], first["fingerprint"]);
    assert!(
        changed["body"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["value"] == "수정된 사유")
    );
    sqlx::query("UPDATE org_change_requests SET proposal=$2 WHERE id=$1")
        .bind(id)
        .bind(json!([{"op":"CREATE_REGION","name":"동부"}]))
        .execute(&pool)
        .await
        .unwrap();
    let proposal_changed = ctx.call("GET", &uri, None).await.1;
    assert_eq!(proposal_changed["body"], changed["body"]);
    assert_ne!(proposal_changed["fingerprint"], changed["fingerprint"]);
    sqlx::query("UPDATE org_change_approval_steps SET decision='APPROVED',decided_by=$2,decided_at=now() WHERE request_id=$1 AND step_order=1")
        .bind(id).bind(checker.as_uuid()).execute(&pool).await.unwrap();
    let maker_ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    sqlx::query("INSERT INTO org_change_events(org_id,request_id,actor,action,from_status,reason) VALUES($1,$2,$3,'step.decide','IN_APPROVAL','hr:APPROVED')")
        .bind(org).bind(id).bind(checker.as_uuid()).execute(&pool).await.unwrap();
    let partial = maker_ctx.call("GET", &uri, None).await.1;
    assert_ne!(partial["fingerprint"], changed["fingerprint"]);
    assert!(partial["revision"].as_u64().unwrap() > first["revision"].as_u64().unwrap());
    assert_eq!(partial["route"][1]["state"], "current");
    sqlx::query("UPDATE org_change_requests SET status='APPROVED',updated_at=now() WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let completed = ctx.call("GET", &uri, None).await;
    assert_eq!(completed.0, StatusCode::OK, "{}", completed.1);
    assert_eq!(completed.1["box"], "completed");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hidden_missing_foreign_draft_and_unrouted_documents_are_indistinguishable(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0001").await;
    let outsider = http::add_user(&pool, org, &["SUPER_ADMIN"]).await;
    let (foreign_org, foreign) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    for (tenant, user) in [(org, outsider), (foreign_org, foreign)] {
        let ctx = http::ctx(&pool, tenant, user, &["SUPER_ADMIN"], None).await;
        for key in [
            format!("org_change:{id}"),
            format!("org_change:{}", Uuid::new_v4()),
            "unknown:record".into(),
            "org_change:bad".into(),
        ] {
            let (status, body) = ctx
                .call("GET", &format!("/api/v1/approvals/{key}"), None)
                .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
            assert_eq!(body["error"]["code"], "not_found");
            assert_eq!(body["error"]["message"], "approval document not found");
            assert!(body.get("body").is_none());
        }
    }
    let revoked = fixtures::document(&pool, org, maker, "OC-2026-0002").await;
    sqlx::query("UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE account_id=$1")
        .bind(checker.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let checker_ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    assert_eq!(
        checker_ctx
            .call(
                "GET",
                &format!("/api/v1/approvals/org_change:{revoked}"),
                None
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    sqlx::query("UPDATE org_change_requests SET status='DRAFT' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        ctx.call("GET", &format!("/api/v1/approvals/org_change:{id}"), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE org_change_requests SET status='IN_APPROVAL' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM org_change_approval_steps WHERE request_id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        ctx.call("GET", &format!("/api/v1/approvals/org_change:{id}"), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn detail_projection_failure_is_sanitized(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0001").await;
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    sqlx::query("ALTER TABLE org_change_events RENAME TO unavailable_org_change_events")
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = ctx
        .call("GET", &format!("/api/v1/approvals/org_change:{id}"), None)
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(body["error"]["code"], "approvals.projection_unavailable");
    assert_eq!(body["error"]["message"], "internal server error");
    assert!(!body.to_string().contains("org_change_events"));
}
