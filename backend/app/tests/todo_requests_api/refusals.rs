// SPDX-License-Identifier: LicenseRef-Proprietary
//! Every way asking can be refused answers its status and code, and leaves no
//! todo row and no audit row behind.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;

use crate::support::{add_user, tenant};
use crate::{Office, REQUESTS, ask_body, code, office};

fn yesterday_kst() -> String {
    (OffsetDateTime::now_utc().to_offset(UtcOffset::from_hms(9, 0, 0).unwrap()) - Duration::days(1))
        .date()
        .to_string()
}

async fn refused(o: &Office, ctx: &crate::Ctx, body: Value, status: StatusCode, want: &str) {
    let (got, out) = ctx.call("POST", REQUESTS, Some(body.clone())).await;
    assert_eq!((got, code(&out)), (status, want), "{body} -> {out}");
    assert_eq!(
        o.written().await,
        (0, 0),
        "{want}: nothing written or audited"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_refusal_to_ask_writes_and_audits_nothing(pool: PgPool) {
    let o = office(pool).await;
    let colleague = *o.colleague.user.as_uuid();
    let gone = add_user(&o.pool, o.org, &[]).await;
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(gone.as_uuid())
        .execute(&o.pool)
        .await
        .unwrap();
    let (_, stranger) = tenant(&o.pool, &[]).await;
    let ask = |assignee: Uuid, extra: Value| {
        let mut body = json!({ "assignee_account_id": assignee, "text": "재고 실사 결과 확인" });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        body
    };
    let unprocessable = StatusCode::UNPROCESSABLE_ENTITY;
    let link = |kind: &str, id: Value| json!({ "links": [{ "kind": kind, "id": id }] });
    let many = json!({ "links": vec![json!({ "kind": "employee", "id": Uuid::new_v4() }); 21] });
    for (body, want) in [
        (ask(*o.admin.user.as_uuid(), json!({})), "todo_assign_self"),
        (ask(Uuid::new_v4(), json!({})), "todo_assignee_out_of_scope"),
        (
            ask(*stranger.as_uuid(), json!({})),
            "todo_assignee_out_of_scope",
        ),
        (ask(*gone.as_uuid(), json!({})), "todo_assignee_inactive"),
        (
            ask(colleague, json!({ "due_on": yesterday_kst() })),
            "todo_due_past",
        ),
        (ask(colleague, json!({ "text": "   " })), "validation"),
        (
            ask(colleague, json!({ "text": "가".repeat(501) })),
            "validation",
        ),
        (
            ask(colleague, link("workOrder", json!(Uuid::new_v4()))),
            "validation",
        ),
        (
            ask(colleague, link("employee", json!("E-1024"))),
            "validation",
        ),
        (ask(colleague, many), "validation"),
    ] {
        refused(&o, &o.admin, body, unprocessable, want).await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refusals_answer_in_order_gate_body_self_assignee_then_due_date(pool: PgPool) {
    let o = office(pool).await;
    let unprocessable = StatusCode::UNPROCESSABLE_ENTITY;
    let past = yesterday_kst();
    // The colleague may not ask at all, whatever the body says.
    let mut body = ask_body(&o.admin);
    body["text"] = json!("   ");
    refused(
        &o,
        &o.colleague,
        body,
        StatusCode::FORBIDDEN,
        "todo_assign_forbidden",
    )
    .await;
    refused(
        &o,
        &o.colleague,
        ask_body(&o.admin),
        StatusCode::FORBIDDEN,
        "todo_assign_forbidden",
    )
    .await;
    // Not even a body that does not parse reaches the colleague ahead of the gate.
    let admin = o.admin.user.as_uuid();
    for broken in [
        json!({}),
        json!({ "assignee_account_id": "E-1024", "text": "x" }),
        json!({ "assignee_account_id": admin, "text": "x", "due_on": "2026/11/20" }),
    ] {
        refused(
            &o,
            &o.colleague,
            broken.clone(),
            StatusCode::FORBIDDEN,
            "todo_assign_forbidden",
        )
        .await;
        refused(&o, &o.admin, broken, unprocessable, "validation").await;
    }
    // The refusal names no value that was sent.
    let echoed = json!({ "assignee_account_id": admin, "text": "x", "links": "인사 메모 원문" });
    let (_, out) = o.admin.call("POST", REQUESTS, Some(echoed)).await;
    assert!(!out.to_string().contains("인사 메모 원문"), "{out}");
    // A bad body before asking yourself, yourself before the lookup, the lookup before the date.
    let me = json!({ "assignee_account_id": o.admin.user.as_uuid(), "text": " ", "due_on": past });
    refused(&o, &o.admin, me, unprocessable, "validation").await;
    let me = json!({ "assignee_account_id": o.admin.user.as_uuid(), "text": "x", "due_on": past });
    refused(&o, &o.admin, me, unprocessable, "todo_assign_self").await;
    let nobody = json!({ "assignee_account_id": Uuid::new_v4(), "text": "x", "due_on": past });
    refused(
        &o,
        &o.admin,
        nobody,
        unprocessable,
        "todo_assignee_out_of_scope",
    )
    .await;
}
