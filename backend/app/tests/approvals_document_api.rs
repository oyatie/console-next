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
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
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
    let ctx = fixtures::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
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
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let uri = format!("/api/v1/approvals/org_change:{id}");
    let (status, first) = ctx.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["document_no"], "OC-2026-0001");
    assert_eq!(first["route"][0]["role_key"], "hr");
    assert_eq!(first["route"][0]["state"], "current");
    assert_eq!(first["body"], json!([]));
    assert_eq!(first["proposal"], json!([]));
    // The approver whose turn it is reads the decision the source takes from them.
    assert_eq!(first["my_actions"]["kind"], "approve");
    assert_eq!(first["opinion_max"], 998);
    assert!(!first["fingerprint"].as_str().unwrap().is_empty());
    assert!(first["revision"].as_u64().unwrap() > 0);
    assert_eq!(ctx.call("GET", &uri, None).await.1, first);
    let maker_ctx = fixtures::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    let own = maker_ctx.call("GET", &uri, None).await.1;
    assert_eq!(own["box"], "requested");
    assert_eq!(own["my_actions"], json!({"kind":"none"}));
    assert_eq!(own["opinion_max"], 0);
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
    assert_eq!(changed["summary"], "수정된 사유");
    sqlx::query("UPDATE org_change_requests SET proposal=$2 WHERE id=$1")
        .bind(id)
        .bind(json!([{"op":"CREATE_REGION","name":"동부"}]))
        .execute(&pool)
        .await
        .unwrap();
    let proposal_changed = ctx.call("GET", &uri, None).await.1;
    assert_eq!(
        proposal_changed["proposal"],
        json!([{"op":"CREATE_REGION","name":"동부"}])
    );
    assert!(proposal_changed["effective_date"].as_str().is_some());
    assert_eq!(proposal_changed["facts"], json!([]));
    assert_eq!(
        proposal_changed["source"],
        json!({"key":"org_change","label":"조직 변경"})
    );
    assert_ne!(proposal_changed["fingerprint"], changed["fingerprint"]);
    sqlx::query("UPDATE org_change_approval_steps SET decision='APPROVED',decided_by=$2,decided_at=now() WHERE request_id=$1 AND step_order=1")
        .bind(id).bind(checker.as_uuid()).execute(&pool).await.unwrap();
    let maker_ctx = fixtures::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
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
        let ctx = fixtures::ctx(&pool, tenant, user, &["SUPER_ADMIN"], None).await;
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
    let checker_ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
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
    let ctx = fixtures::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
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
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn document_fingerprint_excludes_the_viewers_decision_refusal(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0001").await;
    let unbound = http::add_user(&pool, org, &["EXECUTIVE"]).await;
    grants::grant_org_approve(&pool, unbound).await;
    let bound_ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let unbound_ctx = fixtures::ctx(&pool, org, unbound, &["EXECUTIVE"], None).await;
    let uri = format!("/api/v1/approvals/org_change:{id}");
    let (status, bound) = bound_ctx.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, unbound) = unbound_ctx.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bound["decision_refusal"], json!(null));
    assert_eq!(
        unbound["decision_refusal"],
        "org_change.refuse.identity_unbound"
    );
    assert_eq!(bound["fingerprint"], unbound["fingerprint"]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn proposal_names_are_tenant_scoped_and_covered_by_the_fingerprint(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0001").await;
    let unit: Uuid = sqlx::query_scalar("INSERT INTO org_units (org_id) VALUES ($1) RETURNING id")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES($1,$2,1,gen_random_uuid(),$3,sha256('x'::bytea),'{\"name\":\"본점\",\"kind\":\"site\"}','{}')")
        .bind(org).bind(unit).bind(maker.as_uuid()).execute(&pool).await.unwrap();
    let (foreign_org, foreign_user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$1)")
        .bind(foreign_org)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES($1,$1,1,gen_random_uuid(),$2,sha256('x'::bytea),'{\"name\":\"외부 부서\",\"kind\":\"department\"}','{}')").bind(foreign_org).bind(foreign_user.as_uuid()).execute(&pool).await.unwrap();
    let proposal = json!([
        {"op":"CREATE_ORG_UNIT","kind":"DEPARTMENT","parentId":unit,"name":"고객지원부"},
        {"op":"MOVE_ORG_UNIT","orgUnitId":unit,"parentId":foreign_org}
    ]);
    sqlx::query("UPDATE org_change_requests SET proposal=$2 WHERE id=$1")
        .bind(id)
        .bind(&proposal)
        .execute(&pool)
        .await
        .unwrap();
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let uri = format!("/api/v1/approvals/org_change:{id}");
    let (status, first) = ctx.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["proposal"], proposal);
    assert_eq!(first["proposal_names"], json!({unit.to_string(): "본점"}));
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) SELECT org_id,org_unit_id,2,gen_random_uuid(),actor_id,payload_digest,jsonb_set(attributes,'{name}','\"서울본점\"'),receipt FROM org_unit_revisions WHERE org_unit_id=$1")
        .bind(unit).execute(&pool).await.unwrap();
    let (_, changed) = ctx.call("GET", &uri, None).await;
    assert_eq!(changed["proposal_names"][unit.to_string()], "서울본점");
    assert_ne!(changed["fingerprint"], first["fingerprint"]);
}
