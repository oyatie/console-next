// SPDX-License-Identifier: LicenseRef-Proprietary
//! A request moves forward only: open, then done or returned. Withdrawing
//! deletes it, and a private todo stays its owner's alone.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::support::{Ctx, audits, ctx, tenant};
use crate::{Office, REQUESTS, ask_body, code, office, raw_get};

/// `call` is refused with `want`, and nothing more is written or audited.
async fn refused(
    o: &Office,
    ctx: &Ctx,
    method: &str,
    uri: &str,
    body: Option<Value>,
    want: (StatusCode, &str),
) {
    let before = o.written().await;
    let (status, out) = ctx.call(method, uri, body).await;
    assert_eq!((status, code(&out)), want, "{method} {uri} -> {out}");
    assert_eq!(o.written().await, before, "{method} {uri}: nothing written");
}

fn todo(id: &str, tail: &str) -> String {
    format!("/api/v1/me/todos/{id}{tail}")
}

fn note() -> Option<Value> {
    Some(json!({ "note": "할 수 없음: 권한 밖입니다" }))
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn after_a_withdrawal_the_assignees_done_or_return_is_not_found(pool: PgPool) {
    let o = office(pool).await;
    let id = o.ask(&o.colleague).await;
    let asked_with = o.admin.key.get();
    let (status, _) = o
        .admin
        .call("DELETE", &format!("{REQUESTS}/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        o.written().await,
        (0, 2),
        "the row is gone; request and withdraw are audited"
    );
    assert_eq!(audits(&o.pool, o.org, "todo.withdraw").await, 1);
    // The ask's saved outcome outlives the row, but a retry never shows its text again.
    let body = Some(ask_body(&o.colleague));
    let (status, again) = o.admin.send("POST", REQUESTS, body, Some(asked_with)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
    assert!(!again.to_string().contains("근태 마감"), "{again}");
    assert_eq!(o.written().await, (0, 2), "the retry writes nothing");

    let not_found = (StatusCode::NOT_FOUND, "not_found");
    let done = Some(json!({ "done": true }));
    refused(
        &o,
        &o.colleague,
        "POST",
        &todo(&id, "/done"),
        done,
        not_found,
    )
    .await;
    refused(
        &o,
        &o.colleague,
        "POST",
        &todo(&id, "/return"),
        note(),
        not_found,
    )
    .await;
    refused(
        &o,
        &o.admin,
        "DELETE",
        &format!("{REQUESTS}/{id}"),
        None,
        not_found,
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_assignee_cannot_delete_or_reopen_a_request(pool: PgPool) {
    let o = office(pool).await;
    let (c, closed, is_request) = (
        &o.colleague,
        (StatusCode::CONFLICT, "todo_closed"),
        (StatusCode::CONFLICT, "todo_is_request"),
    );
    let done = o.ask(c).await;
    refused(&o, c, "DELETE", &todo(&done, ""), None, is_request).await;
    for _ in 0..2 {
        let (status, out) = c
            .call("POST", &todo(&done, "/done"), Some(json!({ "done": true })))
            .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "done twice answers as before: {out}"
        );
    }
    refused(
        &o,
        c,
        "POST",
        &todo(&done, "/done"),
        Some(json!({ "done": false })),
        closed,
    )
    .await;
    refused(&o, c, "POST", &todo(&done, "/return"), note(), closed).await;
    refused(&o, c, "DELETE", &todo(&done, ""), None, is_request).await;
    refused(
        &o,
        &o.admin,
        "DELETE",
        &format!("{REQUESTS}/{done}"),
        None,
        closed,
    )
    .await;

    let back = o.ask(c).await;
    let (status, _) = c.call("POST", &todo(&back, "/return"), note()).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let snap: Option<Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id = $1 AND action = 'todo.return'",
    )
    .bind(o.org)
    .fetch_one(&o.pool)
    .await
    .unwrap();
    assert_eq!(snap, None, "the return note is never audited");
    refused(&o, c, "POST", &todo(&back, "/return"), note(), closed).await;
    for done in [true, false] {
        refused(
            &o,
            c,
            "POST",
            &todo(&back, "/done"),
            Some(json!({ "done": done })),
            closed,
        )
        .await;
    }
    refused(&o, c, "DELETE", &todo(&back, ""), None, is_request).await;
    refused(
        &o,
        &o.admin,
        "DELETE",
        &format!("{REQUESTS}/{back}"),
        None,
        closed,
    )
    .await;

    let state = |s: &str| format!("{REQUESTS}?state={s}");
    let (_, open) = o.admin.call("GET", &state("open"), None).await;
    assert_eq!(open["items"], json!([]), "{open}");
    let (_, finished) = o.admin.call("GET", &state("done"), None).await;
    assert_eq!(finished["items"][0]["id"], json!(done));
    let (_, returned) = o.admin.call("GET", &state("returned"), None).await;
    assert_eq!(returned["items"][0]["id"], json!(back));
    assert_eq!(
        returned["items"][0]["return_note"],
        json!("할 수 없음: 권한 밖입니다")
    );
    let (status, bad) = o.admin.call("GET", &state("withdrawn"), None).await;
    assert_eq!(
        (status, code(&bad)),
        (StatusCode::UNPROCESSABLE_ENTITY, "validation")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_private_todo_stays_its_owners_and_reads_byte_for_byte_as_before(pool: PgPool) {
    let o = office(pool).await;
    let (status, own) = o
        .colleague
        .call(
            "POST",
            "/api/v1/me/todos",
            Some(json!({ "text": "개인 메모: 서류 정리" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let mine = own["id"].as_str().unwrap().to_owned();
    let keys: Vec<&str> = own
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "id",
            "owner_user_id",
            "text",
            "scopes",
            "links",
            "done",
            "created_at",
            "updated_at",
            "done_at"
        ],
        "a private todo carries no request field"
    );
    let list = "/api/v1/me/todos?include_done=true";
    let before = raw_get(&o.colleague, list).await;
    let asked = o.ask(&o.colleague).await;
    let (status, _) = o
        .colleague
        .call(
            "POST",
            &todo(&asked, "/done"),
            Some(json!({ "done": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        raw_get(&o.colleague, list).await,
        before,
        "requests stay out of the private list"
    );

    let (other, stranger) = tenant(&o.pool, &["SUPER_ADMIN"]).await;
    crate::go_live::go_live(&o.pool, other).await;
    let stranger = ctx(&o.pool, other, stranger, &["SUPER_ADMIN"], None).await;
    let not_found = (StatusCode::NOT_FOUND, "not_found");
    for reader in [&o.admin, &stranger] {
        let (_, list) = reader.call("GET", list, None).await;
        assert!(!list.to_string().contains(&mine), "{list}");
        for state in ["open", "done", "returned"] {
            let (_, asked) = reader
                .call("GET", &format!("{REQUESTS}?state={state}"), None)
                .await;
            assert!(!asked.to_string().contains(&mine), "{asked}");
        }
        refused(
            &o,
            reader,
            "POST",
            &todo(&mine, "/done"),
            Some(json!({ "done": true })),
            not_found,
        )
        .await;
        refused(
            &o,
            reader,
            "POST",
            &todo(&mine, "/return"),
            note(),
            not_found,
        )
        .await;
        refused(&o, reader, "DELETE", &todo(&mine, ""), None, not_found).await;
        refused(
            &o,
            reader,
            "DELETE",
            &format!("{REQUESTS}/{mine}"),
            None,
            not_found,
        )
        .await;
    }
    refused(
        &o,
        &o.colleague,
        "POST",
        &todo(&mine, "/return"),
        note(),
        not_found,
    )
    .await;
    refused(
        &o,
        &o.colleague,
        "DELETE",
        &format!("{REQUESTS}/{mine}"),
        None,
        not_found,
    )
    .await;
}
