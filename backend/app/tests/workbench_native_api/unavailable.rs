// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{
    PATH, RANGE_FROM, RANGE_TO, app_state, assert_source, bearer, get, keys, runtime_role_pool,
    seed_branch, seed_calendar_event, seed_support_ticket, seed_todo, seed_user,
};
use console_app::build_router;
use console_kernel_core::UserId;
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;

pub(super) async fn assert_todo_source_unavailable(pool: PgPool, snapshot_readable: bool) {
    let keys = keys();
    let branch = seed_branch(&pool, "Failure Region", "Failure Branch").await;
    let user = UserId::new();
    seed_user(&pool, user, &[branch]).await;
    let base = OffsetDateTime::parse(
        "2026-07-01T12:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    let support = seed_support_ticket(&pool, branch, user, base).await;
    let event = seed_calendar_event(&pool, user, base).await;
    let _todo = seed_todo(&pool, user, base).await;

    // This is a real source failure at the runtime boundary, not an injected
    // reader double: native todo storage receives SQLSTATE insufficient_privilege
    // while action and calendar retain their independently granted access.
    sqlx::query("REVOKE SELECT ON TABLE todos FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    if snapshot_readable {
        // Requests also select org_id explicitly; the personal snapshot uses tenant RLS.
        sqlx::query(
            "GRANT SELECT (id, owner_user_id, body, scopes, links, done, \
             created_at, updated_at, done_at, assigned_by_user_id, due_on, \
             returned_at, return_note) ON todos TO console_rt",
        )
        .execute(&pool)
        .await
        .unwrap();
    }

    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let response = get(
        service,
        &format!(
            "{PATH}?from={RANGE_FROM}&to={RANGE_TO}&branch_id={branch}&action_limit=1&todo_limit=1&calendar_limit=1"
        ),
        &bearer(&pool, &keys, user, &[branch]).await,
    )
    .await;

    assert_eq!(response.status, StatusCode::OK, "{:?}", response.json);
    assert_eq!(response.json["partial"], true, "{:?}", response.json);
    assert_source(
        &response.json["action_inbox"],
        format!("support:{support}"),
        1,
        false,
    );
    assert_eq!(
        response.json["todos"],
        json!({"status": "unavailable", "code": "todo_unavailable"})
    );
    assert_source(&response.json["calendar"], event.to_string(), 1, false);
}
