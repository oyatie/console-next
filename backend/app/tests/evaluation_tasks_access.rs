// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
#[path = "support/http.rs"]
mod http;

use ::http::StatusCode;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn personal_task_navigation_agrees_with_the_mounted_handler(pool: PgPool) {
    let (org, admin) = http::tenant(&pool, &["ADMIN"]).await;
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
