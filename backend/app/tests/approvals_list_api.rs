// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "../../test-support/org_change_fixtures.rs"]
mod grants;
#[path = "support/http.rs"]
mod http;
#[path = "../../test-support/person_fixtures.rs"]
mod people;
use ::http::StatusCode;
use console_kernel_core::UserId;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn document(pool: &PgPool, org: Uuid, maker: UserId, code: &str) -> Uuid {
    let id = sqlx::query_scalar("INSERT INTO org_change_requests (org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,$2,'REORG','IN_APPROVAL','REGION','region','조직 개편',CURRENT_DATE,'변경 검토','[]',$3,$4,repeat('a',64)) RETURNING id")
        .bind(org).bind(code).bind(maker.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key) VALUES($1,$2,1,'hr'),($1,$2,2,'executive')")
        .bind(org).bind(id).execute(pool).await.unwrap();
    id
}
async fn setup(pool: &PgPool) -> (Uuid, UserId, UserId) {
    let (org, maker) = http::tenant(pool, &["SUPER_ADMIN"]).await;
    let checker = http::add_user(pool, org, &["EXECUTIVE"]).await;
    for user in [maker, checker] {
        people::bind_user_to_distinct_person(pool, user).await;
        grants::grant_org_approve(pool, user).await;
    }
    (org, maker, checker)
}
async fn get(ctx: &http::Ctx, query: &str) -> Value {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("error")
        .with_test_writer()
        .try_init();
    let (status, body) = ctx
        .call("GET", &format!("/api/v1/approvals?{query}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn canonical_list_counts_focus_and_keyset_share_visibility(pool: PgPool) {
    let (org, maker, checker) = setup(&pool).await;
    let mut ids = Vec::new();
    for index in 0..3 {
        ids.push(document(&pool, org, maker, &format!("OC-2026-{index:04}")).await);
    }
    // Equal timestamps exercise the UUID tie breaker.
    sqlx::query("UPDATE org_change_requests SET created_at='2026-01-01T00:00:00Z' WHERE org_id=$1")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let first = get(&ctx, "box=pending&limit=2").await;
    assert_eq!(
        first["counts"],
        json!({"pending":3,"upcoming":0,"requested":0,"reference":0,"completed":0})
    );
    assert_eq!(first["items"].as_array().unwrap().len(), 2);
    assert_eq!(first["items"][0]["source"]["key"], "org_change");
    assert_eq!(first["items"][0]["route"].as_array().unwrap().len(), 2);
    assert_eq!(first["items"][0]["route"][0]["state"], "current");
    assert_eq!(first["items"][0]["route"][0]["role_key"], "hr");
    assert_eq!(first["items"][0]["status"], json!({"key":"IN_APPROVAL"}));
    assert!(first["items"][0]["route"][0].get("label").is_none());
    assert_eq!(first["sources"][0]["count"], 3);
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = get(
        &ctx,
        &format!(
            "box=pending&limit=2&cursor={cursor}&focus={}",
            first["items"][0]["id"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["counts"], first["counts"]);
    assert_eq!(second["focused"], first["items"][0]);
    assert!(second["next_cursor"].is_null());
    assert_ne!(second["items"][0]["id"], first["items"][0]["id"]);
    let filtered = get(&ctx, "box=pending&q=OC-2026-0001&source=org_change").await;
    assert_eq!(filtered["counts"]["pending"], 1);
    assert_eq!(filtered["items"][0]["document_no"], "OC-2026-0001");
    let maker_ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    let requested = get(&maker_ctx, "box=requested").await;
    assert_eq!(requested["counts"]["requested"], 3);
    assert_eq!(requested["counts"]["pending"], 0, "SoD excludes own work");
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn outsiders_and_revoked_grants_leak_no_items_counts_facets_or_focus(pool: PgPool) {
    let (org, maker, checker) = setup(&pool).await;
    let id = document(&pool, org, maker, "OC-2026-0001").await;
    let outsider = http::add_user(&pool, org, &["SUPER_ADMIN"]).await;
    let (foreign_org, foreign) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    sqlx::query("UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE account_id=$1")
        .bind(checker.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    for (tenant, user, role) in [
        (org, outsider, "SUPER_ADMIN"),
        (org, checker, "EXECUTIVE"),
        (foreign_org, foreign, "SUPER_ADMIN"),
    ] {
        let ctx = http::ctx(&pool, tenant, user, &[role], None).await;
        for box_name in ["pending", "upcoming", "requested", "reference", "completed"] {
            let page = get(&ctx, &format!("box={box_name}&focus=org_change:{id}")).await;
            assert_eq!(page["items"], json!([]));
            assert_eq!(page["sources"], json!([]));
            assert!(page["focused"].is_null());
            assert!(page["counts"].as_object().unwrap().values().all(|v| v == 0));
        }
    }
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_list_queries_are_refused_without_reading_documents(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    for query in [
        "box=invalid",
        "box=pending&cursor=bad",
        "box=pending&limit=0",
        "box=pending&limit=101",
    ] {
        assert_eq!(
            ctx.call("GET", &format!("/api/v1/approvals?{query}"), None)
                .await
                .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn completed_documents_only_reach_requesters_and_route_participants(pool: PgPool) {
    let (org, maker, checker) = setup(&pool).await;
    let id = document(&pool, org, maker, "OC-2026-0001").await;
    sqlx::query("UPDATE org_change_approval_steps SET decision='APPROVED',decided_by=$2,decided_at=now() WHERE request_id=$1 AND step_order=1")
        .bind(id).bind(checker.as_uuid()).execute(&pool).await.unwrap();
    let checker_ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    assert_eq!(
        get(&checker_ctx, "box=pending").await["counts"]["pending"],
        0,
        "a prior decider cannot take another step"
    );
    sqlx::query("UPDATE org_change_requests SET status='APPROVED' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let unrelated = http::add_user(&pool, org, &["EXECUTIVE"]).await;
    grants::grant_org_approve(&pool, unrelated).await;
    for (user, expected) in [(maker, 1), (checker, 1), (unrelated, 0)] {
        let ctx = http::ctx(
            &pool,
            org,
            user,
            if user == maker {
                &["SUPER_ADMIN"]
            } else {
                &["EXECUTIVE"]
            },
            None,
        )
        .await;
        let page = get(&ctx, "box=completed").await;
        assert_eq!(page["counts"]["completed"], expected);
        assert_eq!(page["items"].as_array().unwrap().len(), expected as usize);
        assert_eq!(page["counts"]["pending"], 0);
    }
    let rejected = document(&pool, org, maker, "OC-2026-0002").await;
    sqlx::query("UPDATE org_change_approval_steps SET decision='REJECTED',decided_by=$2,decided_at=now() WHERE request_id=$1 AND step_order=1")
        .bind(rejected).bind(checker.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE org_change_requests SET status='REJECTED' WHERE id=$1")
        .bind(rejected)
        .execute(&pool)
        .await
        .unwrap();
    let page = get(&checker_ctx, "box=completed&q=OC-2026-0002").await;
    assert_eq!(page["items"][0]["route"][0]["state"], "failed");
    assert_eq!(page["items"][0]["status"]["key"], "REJECTED");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unrouted_approved_changes_and_cancelled_drafts_are_not_approval_documents(pool: PgPool) {
    let (org, maker, checker) = setup(&pool).await;
    let mut ids = Vec::new();
    for (index, status) in ["APPROVED", "CANCELLED"].into_iter().enumerate() {
        let id = document(&pool, org, maker, &format!("OC-2026-{index:04}")).await;
        sqlx::query("DELETE FROM org_change_approval_steps WHERE request_id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE org_change_requests SET status=$2 WHERE id=$1")
            .bind(id)
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
        ids.push(id);
    }
    for (user, role) in [(maker, "SUPER_ADMIN"), (checker, "EXECUTIVE")] {
        let ctx = http::ctx(&pool, org, user, &[role], None).await;
        for box_name in ["pending", "upcoming", "requested", "reference", "completed"] {
            for id in &ids {
                let page = get(&ctx, &format!("box={box_name}&focus=org_change:{id}")).await;
                assert_eq!(page["items"], json!([]));
                assert_eq!(page["sources"], json!([]));
                assert!(page["focused"].is_null());
                assert!(page["counts"].as_object().unwrap().values().all(|v| v == 0));
            }
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn view_only_reader_cannot_receive_another_persons_pending_approval(pool: PgPool) {
    let (org, maker, checker) = setup(&pool).await;
    let other = document(&pool, org, maker, "OC-2026-0001").await;
    let own = document(&pool, org, checker, "OC-2026-0002").await;
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) SELECT org_id,role_id,2,name_ko,status,change_mode,created_by FROM access_role_versions WHERE version=1 AND role_id IN (SELECT role_id FROM access_grants WHERE account_id=$1)")
        .bind(checker.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,role_id,2,'org',ARRAY['view'] FROM access_grants WHERE account_id=$1")
        .bind(checker.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE access_roles SET version=2 WHERE id IN (SELECT role_id FROM access_grants WHERE account_id=$1)")
        .bind(checker.as_uuid()).execute(&pool).await.unwrap();
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let requested = get(&ctx, "box=requested").await;
    assert_eq!(requested["items"][0]["id"], format!("org_change:{own}"));
    assert_eq!(
        requested["counts"]["requested"], 1,
        "read remains permitted"
    );
    for box_name in ["pending", "upcoming", "reference", "completed"] {
        let page = get(&ctx, &format!("box={box_name}&focus=org_change:{other}")).await;
        assert_eq!(page["items"], json!([]));
        assert_eq!(page["counts"]["pending"], 0);
        assert!(page["focused"].is_null());
        assert_eq!(page["sources"], json!([]));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn projection_failures_return_a_code_without_database_details(pool: PgPool) {
    let (org, maker, checker) = setup(&pool).await;
    document(&pool, org, maker, "OC-2026-0001").await;
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    sqlx::query("ALTER TABLE org_units RENAME TO unavailable_org_units")
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = ctx.call("GET", "/api/v1/approvals?box=pending", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(body["error"]["code"], "approvals.projection_unavailable");
    assert_eq!(body["error"]["message"], "internal server error");
    assert!(
        body["error"]["support_ref"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    assert!(!body.to_string().contains("org_units"));
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn same_person_alias_and_unbound_approvers_have_no_pending_documents(pool: PgPool) {
    let (org, maker, _) = setup(&pool).await;
    document(&pool, org, maker, "OC-2026-0001").await;
    let maker_person: Uuid = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
        .bind(maker.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    for bound in [true, false] {
        let user = http::add_user(&pool, org, &["EXECUTIVE"]).await;
        grants::grant_org_approve(&pool, user).await;
        if bound {
            people::bind_user_to_person(&pool, user, maker_person).await;
        }
        let ctx = http::ctx(&pool, org, user, &["EXECUTIVE"], None).await;
        let page = get(&ctx, "box=pending").await;
        assert_eq!(page["counts"]["pending"], 0);
        assert_eq!(page["items"], json!([]));
    }
}
