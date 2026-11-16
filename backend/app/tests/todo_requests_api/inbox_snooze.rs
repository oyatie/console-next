// SPDX-License-Identifier: LicenseRef-Proprietary
//! Postponing a request changes only the snoozer's own list; the requester's
//! item comes back when the request is sent back. The workbench lists the
//! assignee's request with the request as its target.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::Duration;

use super::inbox::{INBOX, NOTE, ask, inbox, item, today};
use crate::office;
use crate::support::{Ctx, count};

async fn snooze(ctx: &Ctx, id: &str, days: i64) -> (StatusCode, Value) {
    let until = (today() + Duration::days(days)).to_string();
    ctx.call(
        "POST",
        &format!("{INBOX}/items/{id}/snooze"),
        Some(json!({ "until": until })),
    )
    .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn each_side_postpones_its_own_item_and_a_return_wakes_the_requester(pool: PgPool) {
    let o = office(pool).await;
    let id = ask(&o, &o.colleague, Some(today()), json!([])).await;
    let (assigned, requested) = (
        format!("todo_assigned:{id}"),
        format!("todo_requested:{id}"),
    );
    let other = ask(&o, &o.colleague, None, json!([])).await;
    let rows = || count(&o.pool, "action_inbox_snoozes", o.org);

    for (ctx, theirs) in [
        (&o.admin, format!("todo_assigned:{other}")),
        (&o.colleague, format!("todo_requested:{other}")),
    ] {
        let (status, out) = snooze(ctx, &theirs, 3).await;
        assert_eq!(
            (status, out["error"]["code"].as_str()),
            (StatusCode::NOT_FOUND, Some("lifecycle.refuse.scope")),
            "{theirs}"
        );
    }
    assert_eq!(rows().await, 0, "a refusal writes nothing");

    let page = inbox(&o.colleague, "").await;
    let turn = page["counts"]["turn"]["total"].as_u64().unwrap();
    assert_eq!(
        item(&page, &assigned).unwrap()["snooze"],
        json!({ "allowed": true })
    );
    let (status, out) = snooze(&o.colleague, &assigned, 3).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{out}");
    let page = inbox(&o.colleague, "").await;
    assert!(item(&page, &assigned).is_none());
    assert_eq!(page["counts"]["turn"]["total"], json!(turn - 1));
    let page = inbox(&o.colleague, "?snoozed=only").await;
    let held = item(&page, &assigned).unwrap();
    assert_eq!(
        held["snooze"]["until"],
        json!((today() + Duration::days(3)).to_string())
    );
    let open = item(&inbox(&o.admin, "").await, &requested).unwrap();
    assert_eq!(
        open["snooze"],
        json!({ "allowed": true }),
        "the other side is unchanged"
    );

    let (status, out) = snooze(&o.admin, &requested, 3).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{out}");
    let page = inbox(&o.admin, "").await;
    assert!(item(&page, &requested).is_none());
    assert_eq!(page["counts"]["snoozed"]["total"], json!(1));
    let (status, out) = o
        .colleague
        .call(
            "POST",
            &format!("/api/v1/me/todos/{id}/return"),
            Some(json!({ "note": NOTE })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{out}");
    let page = inbox(&o.admin, "").await;
    let back = item(&page, &requested).expect("a return wakes the requester's item");
    assert_eq!(back["context"]["todo"]["state"], "returned");
    assert_eq!(page["counts"]["snoozed"]["total"], json!(0));
}

/// The workbench reads the same sources: the assignee's request is an action whose target is the request.
#[cfg(feature = "workspace")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_workbench_lists_the_assignees_request(pool: PgPool) {
    let o = office(pool).await;
    let id = ask(&o, &o.colleague, None, json!([])).await;
    let (status, bench) = o.colleague.call("GET", "/api/v1/me/workbench", None).await;
    assert_eq!(status, StatusCode::OK, "{bench}");
    let actions = &bench["action_inbox"];
    assert_eq!(actions["status"], "ok", "{actions}");
    let action = actions["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|action| action["id"] == format!("todo_assigned:{id}"))
        .unwrap_or_else(|| panic!("{actions}"));
    assert_eq!(action["target"], json!({ "module": "todo", "id": id }));
    assert_eq!(action["source"]["kind"], "todo_assigned");
}
