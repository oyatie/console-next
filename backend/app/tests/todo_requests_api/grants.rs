// SPDX-License-Identifier: LicenseRef-Proprietary
//! Who may ask: the founder and holders of a to-do request grant. Another
//! grant, a legacy built-in role and another tenant reach nothing on any
//! request route.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

use crate::support::{add_user, ctx, tenant};
use crate::world::world;
use crate::{ASSIGNEES, REQUESTS, ask_body, code, office, written};

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

/// Editing every personnel card over the whole tenant is not asking anyone.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hr_editing_does_not_carry_asking(pool: PgPool) {
    let mut w = world(pool).await;
    let editor = w.holder("TENANT", None).await;
    let forbidden = (StatusCode::FORBIDDEN, "todo_assign_forbidden");

    let (status, out) = editor.call("POST", REQUESTS, Some(ask_body(&w.ops))).await;
    assert_eq!((status, code(&out)), forbidden, "{out}");
    let (status, out) = editor.call("GET", ASSIGNEES, None).await;
    assert_eq!((status, code(&out)), forbidden, "{out}");
    assert_eq!(written(&w.pool, w.org).await, (0, 0));
}

/// Each party reaches a live request only in its own role: the requester
/// cannot finish, return or delete it as an owner, nor the assignee withdraw it.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn each_party_reaches_a_request_only_in_its_own_role(pool: PgPool) {
    let o = office(pool).await;
    let id = o.ask(&o.colleague).await;
    let written = o.written().await;
    let todo = format!("/api/v1/me/todos/{id}");
    for (who, method, uri, body) in [
        (
            &o.admin,
            "POST",
            format!("{todo}/done"),
            Some(json!({ "done": true })),
        ),
        (
            &o.admin,
            "POST",
            format!("{todo}/return"),
            Some(json!({ "note": "취소" })),
        ),
        (&o.admin, "DELETE", todo.clone(), None),
        (&o.colleague, "DELETE", format!("{REQUESTS}/{id}"), None),
    ] {
        let (status, out) = who.call(method, &uri, body).await;
        assert_eq!(
            (status, code(&out)),
            (StatusCode::NOT_FOUND, "not_found"),
            "{method} {uri}"
        );
    }
    assert_eq!(o.written().await, written, "nothing written or audited");
}
