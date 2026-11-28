// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
#[path = "support/http.rs"]
mod http;

use ::http::StatusCode;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn personal_task_navigation_agrees_with_the_mounted_handler(pool: PgPool) {
    let (org, admin) = http::tenant(&pool, &["ADMIN"]).await;
    enroll(&pool, org).await;
    let member = http::add_user(&pool, org, &["MEMBER"]).await;
    let branchless = http::add_user(&pool, org, &["ADMIN"]).await;
    let branch: uuid::Uuid = sqlx::query_scalar("WITH r AS (INSERT INTO regions (org_id,name) VALUES ($1,'North') RETURNING id) INSERT INTO branches (org_id,region_id,name) SELECT $1,id,'Harbor' FROM r RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    for user in [admin, member] {
        sqlx::query("INSERT INTO user_branches (user_id,branch_id,org_id) VALUES ($1,$2,$3)")
            .bind(user.as_uuid())
            .bind(branch)
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
    }
    for (user, role, permitted) in [
        (admin, "ADMIN", true),
        (branchless, "ADMIN", false),
        (member, "MEMBER", false),
    ] {
        let ctx = http::ctx(&pool, org, user, &[role], None).await;
        let (status, projection) = ctx.call("GET", "/api/v1/me/authz", None).await;
        assert_eq!(status, StatusCode::OK, "{projection}");
        let advertised = projection["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cap| cap["feature"] == "served_evaluation_tasks");
        let (status, page) = ctx.call("GET", "/api/v1/evaluation/my-tasks", None).await;
        let expected = match (cfg!(feature = "evaluation"), permitted) {
            (false, _) => StatusCode::NOT_FOUND,
            (true, false) => StatusCode::FORBIDDEN,
            (true, true) => StatusCode::OK,
        };
        assert_eq!(status, expected, "{page}");
        assert_eq!(advertised, status == StatusCode::OK);
    }
}

async fn enroll(pool: &PgPool, org: uuid::Uuid) {
    sqlx::query("INSERT INTO tenant_module_enrollments (org_id,module_key,enabled,change_ref) VALUES ($1,'evaluation',true,'test-enrollment')")
        .bind(org).execute(pool).await.unwrap();
}

#[cfg(feature = "evaluation")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_policy_precedes_reads_and_command_replay(pool: PgPool) {
    let (org, admin) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let (other, _) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, admin, &["SUPER_ADMIN"], None).await;
    let path = "/api/v1/evaluation/cycles";
    let input = serde_json::json!({"name":"Scoped cycle","kind":"REGULAR","period_label":"2026","due_date":"2026-12-31"});
    enroll(&pool, other).await;
    for method in ["GET", "POST"] {
        let (status, body) = ctx
            .call(method, path, (method == "POST").then(|| input.clone()))
            .await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::FORBIDDEN, Some("module_disabled")),
            "{body}"
        );
    }
    enroll(&pool, org).await;
    let (status, body) = ctx.call("POST", path, Some(input.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let key = ctx.key.get();
    let (status, body) = ctx.retry("POST", path, Some(input.clone())).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("command_applied")),
        "{body}"
    );
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code) VALUES ($1,'module.evaluation.enabled','false',clock_timestamp(),$2,'POLICY_REVIEW')")
        .bind(org).bind(admin.as_uuid()).execute(&pool).await.unwrap();
    let (status, body) = ctx.send("POST", path, Some(input), Some(key)).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("module_disabled")),
        "{body}"
    );
    let (status, authz) = ctx.call("GET", "/api/v1/me/authz", None).await;
    assert_eq!(status, StatusCode::OK, "{authz}");
    assert!(authz["capabilities"].as_array().unwrap().iter().all(|cap| {
        !cap["feature"]
            .as_str()
            .unwrap()
            .starts_with("served_evaluation_")
    }));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM evaluation_cycles WHERE org_id=$1")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_role_cannot_enroll_itself_or_read_another_tenants_enrollment(pool: PgPool) {
    let (org, _) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let (other, _) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    enroll(&pool, other).await;
    let runtime = console_platform_test_support::runtime_role_pool(&pool).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT count(revision) FROM tenant_module_enrollments")
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(rows, 0);
    let error = sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,'evaluation',true,'self-grant')")
        .bind(org).execute(tx.as_mut()).await.unwrap_err();
    assert_eq!(
        error.as_database_error().and_then(|e| e.code()).as_deref(),
        Some("42501")
    );
}
