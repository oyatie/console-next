// SPDX-License-Identifier: LicenseRef-Proprietary
//! Who may ask: the founder and tenant-wide HR editors. A narrower grant, a
//! legacy built-in role and another tenant reach nothing on any request route.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

use crate::support::{add_user, ctx, tenant};
use crate::world::world;
use crate::{REQUESTS, ask_body, code, office};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_lower_grant_and_another_tenant_reach_nothing_on_any_request_route(pool: PgPool) {
    let o = office(pool).await;
    let id = o.ask(&o.colleague).await;
    let written = o.written().await;

    let admin = add_user(&o.pool, o.org, &["ADMIN"]).await;
    let legacy_admin = ctx(&o.pool, o.org, admin, &["ADMIN"], None).await;
    let (other, founder) = tenant(&o.pool, &["SUPER_ADMIN"]).await;
    crate::go_live::go_live(&o.pool, other).await;
    let stranger = ctx(&o.pool, other, founder, &["SUPER_ADMIN"], None).await;

    for (who, ask) in [
        (
            &legacy_admin,
            (StatusCode::FORBIDDEN, "todo_assign_forbidden"),
        ),
        (
            &stranger,
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                "todo_assignee_out_of_scope",
            ),
        ),
    ] {
        let (status, out) = who
            .call("POST", REQUESTS, Some(ask_body(&o.colleague)))
            .await;
        assert_eq!((status, code(&out)), ask, "{out}");
        let (status, list) = who
            .call("GET", &format!("{REQUESTS}?state=open"), None)
            .await;
        assert_eq!(
            (status, &list["items"]),
            (StatusCode::OK, &json!([])),
            "{list}"
        );
        let (status, out) = who.call("DELETE", &format!("{REQUESTS}/{id}"), None).await;
        assert_eq!((status, code(&out)), (StatusCode::NOT_FOUND, "not_found"));
        let back = Some(json!({ "note": "제 일이 아닙니다" }));
        let (status, out) = who
            .call("POST", &format!("/api/v1/me/todos/{id}/return"), back)
            .await;
        assert_eq!((status, code(&out)), (StatusCode::NOT_FOUND, "not_found"));
    }
    assert_eq!(o.written().await, written, "nothing written or audited");
    let foreign: i64 = sqlx::query_scalar("SELECT count(*) FROM todos WHERE org_id = $1")
        .bind(other)
        .fetch_one(&o.pool)
        .await
        .unwrap();
    assert_eq!(foreign, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_tenant_wide_hr_editor_asks_and_a_legal_entity_hr_editor_cannot(pool: PgPool) {
    let mut w = world(pool).await;
    let tenant_wide = w.holder("TENANT", None).await;
    let le_a = w.le_a.clone();
    let entity_only = w.holder("LEGAL_ENTITY", Some(&le_a)).await;

    let (status, out) = tenant_wide
        .call("POST", REQUESTS, Some(ask_body(&entity_only)))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{out}");

    let (status, out) = entity_only
        .call("POST", REQUESTS, Some(ask_body(&tenant_wide)))
        .await;
    assert_eq!(
        (status, code(&out)),
        (StatusCode::FORBIDDEN, "todo_assign_forbidden"),
        "{out}"
    );
    let asked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM todos WHERE org_id = $1 AND assigned_by_user_id = $2",
    )
    .bind(w.org)
    .bind(entity_only.user.as_uuid())
    .fetch_one(&w.pool)
    .await
    .unwrap();
    assert_eq!(asked, 0);
}
