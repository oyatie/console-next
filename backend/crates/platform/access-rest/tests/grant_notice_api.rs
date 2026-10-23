#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The grant notice over HTTP (decisions D0.2, 155): only the holder of a live
//! grant confirms it, once; every refusal writes nothing.

mod support;

use axum::http::{Method, StatusCode};
use console_kernel_core::FixedClock;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{World, grant_op, world};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

fn notice(grant: &Value) -> String {
    format!("/api/v1/access/grants/{}/notice", grant.as_str().unwrap())
}

async fn notices(w: &World) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM authz_grant_ledger WHERE org_id = $1 AND event = 'NOTICE_DELIVERED' \
         AND grant_kind = 'ACCESS_GRANT'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap()
}

async fn noticed_at(w: &World) -> Value {
    let (status, me) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    me["entries"][0]["noticed_at"].clone()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_the_holder_confirms_a_live_grants_notice_once(pool: PgPool) {
    let mut w = world(pool.clone()).await;
    w.go_live().await;
    let role = w
        .role(
            "마감",
            json!([{ "domain": "exceptions", "levels": ["edit"] }]),
        )
        .await;
    let granted = w
        .grant(json!([grant_op(w.hr, role, "TENANT", None, false)]))
        .await;
    let grant = granted[0]["id"].clone();
    assert_eq!(noticed_at(&w).await, Value::Null, "not noticed yet");

    // Refusals, none of which writes a notice: someone else (ops included), an
    // unknown grant, another tenant.
    for who in [w.hr2, w.ops] {
        let (status, body) = w.call(Method::POST, &notice(&grant), who, None).await;
        assert_eq!(
            (status, body["error"]["code"].clone()),
            (StatusCode::FORBIDDEN, json!("grant_notice_not_holder")),
            "{body}"
        );
    }
    let unknown = json!(Uuid::new_v4().to_string());
    let (status, body) = w.call(Method::POST, &notice(&unknown), w.hr, None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("grant_not_found"))
    );
    let other = world(pool).await;
    let (status, body) = other
        .call(Method::POST, &notice(&grant), other.hr, None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("grant_not_found"))
    );
    assert_eq!(notices(&w).await, 0);

    let (status, body) = w.call(Method::POST, &notice(&grant), w.hr, None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("grant_ended"))
    );
    assert_eq!(notices(&w).await, 0, "a pending grant cannot be noticed");
    assert_eq!(granted[0]["enforcement"], "SCHEDULED");
    let due =
        OffsetDateTime::parse(granted[0]["activates_at"].as_str().unwrap(), &Rfc3339).unwrap();
    assert_eq!(
        console_platform_access::pending::activate_due(&w.owner, &FixedClock(due))
            .await
            .unwrap(),
        1
    );

    // The holder confirms; again answers with the first confirmation.
    let (status, first) = w.call(Method::POST, &notice(&grant), w.hr, None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(
        (first["grant_id"].clone(), first["channel"].clone()),
        (grant.clone(), json!("IN_APP"))
    );
    let (status, again) = w.call(Method::POST, &notice(&grant), w.hr, None).await;
    assert_eq!(
        (status, again["noticed_at"].clone()),
        (StatusCode::OK, first["noticed_at"].clone())
    );
    assert_eq!(notices(&w).await, 1);
    assert_eq!(noticed_at(&w).await, first["noticed_at"]);
    let (who, channel): (Uuid, String) = sqlx::query_as(
        "SELECT actor_id, channel FROM authz_grant_ledger WHERE org_id = $1 AND event = 'NOTICE_DELIVERED'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!((who, channel.as_str()), (*w.hr.as_uuid(), "IN_APP"));

    // A revoked grant has nothing left to notice.
    let revoked = w
        .grant(json!([{ "op": "revoke", "grant_id": grant }]))
        .await;
    assert_eq!(revoked[0]["enforcement"], "REVOKED");
    let (status, body) = w.call(Method::POST, &notice(&grant), w.hr, None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("grant_ended"))
    );
    assert_eq!(notices(&w).await, 1);
}
