#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/http.rs"]
mod support;

use http::StatusCode;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn audit_read_uses_live_authority_after_role_removal(pool: PgPool) {
    let (org, user) = support::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = support::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (status, body) = ctx.call("GET", "/api/audit?limit=10&offset=0", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let before = support::audits(&pool, org, "audit.read").await;
    assert_eq!(before, 1);
    let actor: uuid::Uuid = sqlx::query_scalar(
        "SELECT actor FROM audit_events WHERE org_id=$1 AND action='audit.read'",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(actor, *user.as_uuid());
    sqlx::query("UPDATE users SET roles=ARRAY['MEMBER'] WHERE org_id=$1 AND id=$2")
        .bind(org)
        .bind(user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = ctx.call("GET", "/api/audit?limit=10&offset=0", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(support::audits(&pool, org, "audit.read").await, before);
}
