#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R2 ENDS over HTTP: the 사업장 close job is mounted behind the request
//! context and needs BOTH `legal_entity_manage` (Cedar) and the HR manage
//! door — either missing is 403 with nothing written; the ops account passes
//! both and meets the adapter's own refusals on the wire (404, the
//! Idempotency-Key). The adapter suite (hr tests/close_plan) proves the rest.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/go_live.rs"]
mod go_live;
#[path = "emp_ui_routes/harness.rs"]
mod harness;

use harness::{Caller, keys, router, token, user};

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

async fn written(pool: &PgPool) -> (i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM workplace_close_jobs), \
                (SELECT count(*) FROM audit_events WHERE action LIKE 'workplace.close%')",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_close_job_needs_both_doors_and_refuses_on_the_wire(pool: PgPool) {
    let org = Uuid::new_v4();
    go_live::live_org(
        &pool,
        org,
        format!("close-{}", &org.simple().to_string()[..12]),
        "Close HTTP",
    )
    .await;
    let keys = keys();
    let service = router(&pool, &keys).await;
    let mut callers = Vec::new();
    for role in ["SUPER_ADMIN", "ADMIN", "EXECUTIVE"] {
        let id = user(&pool, org, role).await;
        callers.push(Caller {
            service: service.clone(),
            token: Some(token(&pool, &keys, org, id, role).await),
        });
    }
    let [ops, hr_only, entity_only] = <[Caller; 3]>::try_from(callers).ok().unwrap();
    let workplace = Uuid::new_v4();
    let path = format!("/api/v1/workplaces/{workplace}/close-plan");
    let plan = json!({ "closed_on": "2099-01-01", "people": [], "units": [] });

    // HR manage without legal_entity_manage, and legal_entity_manage without HR manage: 403 each.
    for caller in [&hr_only, &entity_only] {
        for (method, uri, body) in [
            ("POST", path.clone(), Some(plan.clone())),
            ("POST", format!("{path}/cancel"), None),
        ] {
            let (status, body) = caller.call(method, &uri, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        }
    }
    let (status, body) = entity_only.call("GET", &path, None).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the plan read names people: {body}"
    );
    assert_eq!(written(&pool).await, (0, 0));

    // The ops account passes both doors: an unknown 사업장 is 404, never a 500.
    let (status, body) = ops.call("POST", &path, Some(plan.clone())).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::NOT_FOUND, "workplace_not_found"),
        "{body}"
    );
    let (status, body) = ops.call("GET", &path, None).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::NOT_FOUND, "workplace_not_found"),
        "{body}"
    );
    // A write without an Idempotency-Key is refused before anything runs.
    let (status, body) = ops.send("POST", &path, Some(plan), false).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    // 전적 is not a value the wire takes silently: an unknown action is a 4xx.
    let bad = json!({ "closed_on": "2099-01-01", "people": [{ "employee_id": Uuid::new_v4(), "action": "SOMETHING" }] });
    let (status, _) = ops.call("POST", &path, Some(bad)).await;
    assert!(status.is_client_error());
    assert_eq!(written(&pool).await, (0, 0));
}
