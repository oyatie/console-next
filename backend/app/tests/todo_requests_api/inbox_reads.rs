// SPDX-License-Identifier: LicenseRef-Proprietary
//! How the inbox reads requests: one statement per source page whatever the
//! count, the request text and return note in no log line and no audit row,
//! nothing in the personnel access log, and an activity list of the request's
//! own events.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

use super::inbox::{INBOX, NOTE, TEXT, ask, inbox, named};
use crate::office;
use crate::reference_logs::Logs;
use crate::support::{Ctx, add_user, ctx};

/// Every event of `call` at DEBUG, as JSON lines appended to `logs`.
async fn captured(logs: &Logs, ctx: &Ctx, method: &str, uri: &str, body: Option<Value>) -> Value {
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_max_level(tracing::Level::DEBUG)
        .with_writer(move || writer.clone())
        .finish();
    let (status, out) = ctx
        .call(method, uri, body)
        .with_subscriber(subscriber)
        .await;
    assert!(status.is_success(), "{method} {uri}: {status} {out}");
    out
}

/// Reads of `todos` the inbox made inside each to-do source's span.
fn reads_by_source(logs: &Logs) -> [(usize, usize); 2] {
    let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    let events: Vec<Value> = raw
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    ["TodoAssigned", "TodoRequested"].map(|source| {
        let inside: Vec<&Value> = events
            .iter()
            .filter(|event| {
                event["spans"]
                    .as_array()
                    .is_some_and(|spans| spans.iter().any(|span| span["source"] == source))
            })
            .collect();
        let reads = inside
            .iter()
            .filter(|event| {
                event["target"] == "sqlx::query"
                    && event["fields"]["db.statement"]
                        .as_str()
                        .is_some_and(|sql| sql.contains("FROM todos"))
            })
            .count();
        (inside.len(), reads)
    })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn one_statement_reads_each_side_whatever_the_count(pool: PgPool) {
    let o = office(pool).await;
    // Registers the inbox's trace sites before any capture, so a site first met on another test's
    // thread while a capture starts cannot keep a cached "not interested".
    inbox(&o.colleague, "").await;
    let mut asked = 0;
    for size in [2, 20] {
        while asked < size {
            ask(&o, &o.colleague, None, json!([])).await;
            asked += 1;
        }
        for reader in [&o.colleague, &o.admin] {
            let logs = Logs::default();
            let page = captured(&logs, reader, "GET", &format!("{INBOX}?limit=200"), None).await;
            assert_eq!(super::inbox::requests(&page).len(), size, "{page}");
            for (source, (events, reads)) in
                ["assigned", "requested"].iter().zip(reads_by_source(&logs))
            {
                assert!(events > 0, "the {source} span was captured");
                assert_eq!(reads, 1, "{size} requests, {source}: one statement");
            }
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_text_and_note_reach_no_log_line_audit_row_or_access_log(pool: PgPool) {
    let o = office(pool).await;
    named(&o.pool, &o.colleague, "담당자 나").await;
    let logs = Logs::default();
    let employee = Uuid::new_v4();
    let body = json!({
        "assignee_account_id": o.colleague.user.as_uuid(),
        "text": TEXT,
        "links": [{ "kind": "employee", "id": employee }],
    });
    let made = captured(&logs, &o.admin, "POST", crate::REQUESTS, Some(body)).await;
    let id = made["id"].as_str().unwrap();
    let (assigned, requested) = (
        format!("todo_assigned:{id}"),
        format!("todo_requested:{id}"),
    );
    captured(&logs, &o.colleague, "GET", INBOX, None).await;
    captured(&logs, &o.admin, "GET", INBOX, None).await;
    let until = (super::inbox::today() + time::Duration::days(2)).to_string();
    for (ctx, item) in [(&o.colleague, &assigned), (&o.admin, &requested)] {
        captured(
            &logs,
            ctx,
            "GET",
            &format!("{INBOX}/items/{item}/activity"),
            None,
        )
        .await;
        let uri = format!("{INBOX}/items/{item}/snooze");
        captured(&logs, ctx, "POST", &uri, Some(json!({ "until": until }))).await;
    }
    let uri = format!("/api/v1/me/todos/{id}/return");
    captured(
        &logs,
        &o.colleague,
        "POST",
        &uri,
        Some(json!({ "note": NOTE })),
    )
    .await;
    let page = captured(&logs, &o.admin, "GET", INBOX, None).await;
    assert_eq!(
        super::inbox::item(&page, &requested).unwrap()["context"]["todo"]["return_note"],
        NOTE,
        "the requester reads the note in their own item"
    );
    captured(
        &logs,
        &o.admin,
        "GET",
        &format!("{INBOX}/items/{requested}/activity"),
        None,
    )
    .await;

    let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(
        raw.contains("inbox source measured"),
        "the capture saw the reads"
    );
    for (what, marker) in [("text", "QX41"), ("note", "ZR77")] {
        assert!(!raw.contains(marker), "the request {what} is in a log line");
        let audited: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events a WHERE a.org_id = $1 AND to_jsonb(a)::text LIKE '%' || $2 || '%'",
        )
        .bind(o.org)
        .bind(marker)
        .fetch_one(&o.pool)
        .await
        .unwrap();
        assert_eq!(audited, 0, "the request {what} is in an audit row");
    }
    // The administrator's own HR rows are logged as usual; the request, and every read by the colleague, are not.
    let access: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events a WHERE a.org_id = $1 \
         AND a.action IN ('employee.list_read', 'employee_exit_case.list_read') \
         AND (a.actor = $2 OR to_jsonb(a)::text LIKE '%' || $3 || '%')",
    )
    .bind(o.org)
    .bind(o.colleague.user.as_uuid())
    .bind(employee.to_string())
    .fetch_one(&o.pool)
    .await
    .unwrap();
    assert_eq!(
        access, 0,
        "a to-do item is not a read of an employee record"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_requesters_activity_shows_the_return_then_the_ask(pool: PgPool) {
    let o = office(pool).await;
    let asker = named(&o.pool, &o.admin, "요청자 가").await;
    let owner = named(&o.pool, &o.colleague, "담당자 나").await;
    let id = ask(&o, &o.colleague, None, json!([])).await;
    let (status, out) = o
        .colleague
        .call(
            "POST",
            &format!("/api/v1/me/todos/{id}/return"),
            Some(json!({ "note": NOTE })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{out}");
    let uri = format!("{INBOX}/items/todo_requested:{id}/activity");
    let (status, activity) = o.admin.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{activity}");
    let rows = activity["items"].as_array().unwrap();
    let said: Vec<(&Value, &Value)> = rows
        .iter()
        .map(|row| (&row["verb"], &row["actor_name"]))
        .collect();
    assert_eq!(
        said,
        [
            (&json!("return"), &json!(owner)),
            (&json!("submit"), &json!(asker))
        ],
        "{activity}"
    );
    for row in rows {
        let mut keys: Vec<&str> = row
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["actor_name", "occurred_at", "verb"],
            "no snapshot: {row}"
        );
    }

    let third = add_user(&o.pool, o.org, &[]).await;
    let third = ctx(&o.pool, o.org, third, &[], None).await;
    let (status, refused) = third.call("GET", &uri, None).await;
    assert_eq!(
        (status, refused["error"]["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("inbox_item_not_found"))
    );
    assert!(!inbox(&third, "").await.to_string().contains(&id));
}
