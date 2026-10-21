use super::test_support::{Fixture, body};
use console_platform_test_support::MIGRATOR;
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use std::time::Duration;

#[test]
fn fingerprint_ignores_proof_but_binds_actual_inputs() {
    assert_eq!(
        super::fingerprint(br#"{"a":1,"step_up":{"ceremony_id":"old"}}"#),
        super::fingerprint(br#"{"step_up":{"ceremony_id":"new"},"a":1}"#)
    );
    assert_ne!(
        super::fingerprint(br#"{"a":1}"#),
        super::fingerprint(br#"{"a":2}"#)
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn invalid_request_key_is_422_and_audited_without_registering_or_writing(pool: PgPool) {
    let f = Fixture::new(pool).await;
    f.refused(
        f.send("short", json!({"value":"private"})).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_request_key",
        0,
        1,
    )
    .await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM command_outcomes WHERE org_id=$1")
        .bind(f.principal.org_id.as_uuid())
        .fetch_one(&f.owner)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let (source, actor_kind, session): (String, String, Option<uuid::Uuid>) = sqlx::query_as(
        "SELECT source,actor_kind,session_id FROM audit_events WHERE org_id=$1 AND action='command.refused'",
    ).bind(f.principal.org_id.as_uuid()).fetch_one(&f.owner).await.unwrap();
    assert_eq!(
        (source.as_str(), actor_kind.as_str()),
        ("FORM", "OPS_ACCOUNT")
    );
    assert!(session.is_some());
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn idempotency_key_reused_is_409_and_audited_without_a_second_write(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let key = "ledger-mismatch-original";
    assert_eq!(
        f.send(key, json!({"value":"original"})).await.status(),
        StatusCode::CREATED
    );
    let original = f.outcome(key).await;
    let refused = f
        .refused(
            f.send(key, json!({"value":"changed"})).await,
            StatusCode::CONFLICT,
            "idempotency_key_reused",
            1,
            1,
        )
        .await;
    assert_eq!(refused["error"]["operation_id"], original.id.to_string());
    assert_eq!(f.outcome(key).await.result, original.result);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn concurrent_command_processing_is_409_and_audited_before_one_commit(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let key = "ledger-concurrent-original";
    let payload = json!({"mode":"hold","value":"private"});
    let original = f.clone();
    let input = payload.clone();
    let first = tokio::spawn(async move { original.send(key, input).await });
    tokio::time::timeout(Duration::from_secs(5), f.entered.notified())
        .await
        .unwrap();
    let retry = tokio::time::timeout(Duration::from_secs(5), f.send(key, payload))
        .await
        .unwrap();
    let refused = f
        .refused(retry, StatusCode::CONFLICT, "command_processing", 0, 1)
        .await;
    let registered = f.outcome(key).await;
    assert_eq!(registered.state, "PROCESSING");
    assert_eq!(refused["error"]["operation_id"], registered.id.to_string());
    f.release.notify_one();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), first)
            .await
            .unwrap()
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(f.writes().await, 1);
    assert_eq!(f.outcome(key).await.state, "APPLIED");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn command_applied_without_safe_result_is_409_and_audited_without_reapplying(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let key = "ledger-applied-no-result";
    let payload = json!({"mode":"no_result","value":"private"});
    assert_eq!(
        f.send(key, payload.clone()).await.status(),
        StatusCode::CREATED
    );
    let original = f.outcome(key).await;
    assert_eq!(original.state, "APPLIED");
    assert!(original.result.is_none());
    let refused = f
        .refused(
            f.send(key, payload).await,
            StatusCode::CONFLICT,
            "command_applied",
            1,
            1,
        )
        .await;
    assert_eq!(refused["error"]["operation_id"], original.id.to_string());
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn command_settled_is_409_and_audited_after_refusal_rolls_back_business_write(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let key = "ledger-refused-original";
    let payload = json!({"mode":"refuse","value":"private"});
    f.refused(
        f.send(key, payload.clone()).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation",
        0,
        1,
    )
    .await;
    let original = f.outcome(key).await;
    assert_eq!(original.state, "REFUSED");
    assert_eq!(original.refusal_code.as_deref(), Some("validation"));
    assert!(original.result.is_none());
    let refused = f
        .refused(
            f.send(key, payload).await,
            StatusCode::CONFLICT,
            "command_settled",
            0,
            1,
        )
        .await;
    assert_eq!(refused["error"]["operation_id"], original.id.to_string());
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn lost_response_replays_once_but_current_permission_loss_masks_result(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let key = "ledger-lost-response-original";
    let payload = json!({"value":"private-result","step_up":{"ceremony_id":"old"}});
    let lost = f.send(key, payload).await;
    assert_eq!(lost.status(), StatusCode::CREATED);
    let id = lost.headers()["operation-id"].to_str().unwrap().to_owned();
    drop(lost);
    let replay = f
        .send(
            key,
            json!({"value":"private-result","step_up":{"ceremony_id":"new"}}),
        )
        .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["operation-id"], id);
    assert_eq!(body(replay).await["value"], "private-result");
    assert_eq!(f.writes().await, 1);
    let restricted = f.without_read();
    assert!(
        !crate::record_access::may_read(
            &restricted.rt,
            &restricted.principal,
            "user",
            &restricted.principal.user_id.to_string(),
            None
        )
        .await
    );
    let refused = restricted
        .refused(
            f.without_read()
                .send(key, json!({"value":"private-result"}))
                .await,
            StatusCode::CONFLICT,
            "command_applied",
            1,
            1,
        )
        .await;
    assert_eq!(refused["error"]["operation_id"], id);
    assert!(!refused.to_string().contains("private-result"));
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn last_change_409_names_newest_mutation_excludes_reads_and_masks_nonreader(pool: PgPool) {
    let f = Fixture::new(pool).await;
    f.history(
        "user.update",
        "Earlier editor",
        json!({"display_name":"first"}),
        json!({"display_name":"second"}),
    )
    .await;
    let latest = f
        .history(
            "user.update",
            "Newest editor",
            json!({"display_name":"secret-old","unchanged":"same"}),
            json!({"display_name":"secret-new","unchanged":"same"}),
        )
        .await;
    let later_read = f
        .history("user.read", "Later reader", json!({}), json!({}))
        .await;
    let refused = f
        .refused(
            f.send(
                "ledger-conflict-readable",
                json!({"mode":"stale","value":"private"}),
            )
            .await,
            StatusCode::CONFLICT,
            "stale_revision",
            0,
            1,
        )
        .await;
    let change = &refused["error"]["last_change"];
    assert_eq!(change["actor_name"], "Newest editor");
    assert_eq!(change["actor_kind"], "OPS_ACCOUNT");
    assert_eq!(change["audit_id"], latest.to_string());
    assert_ne!(change["audit_id"], later_read.to_string());
    assert!(change["recorded_at"].as_str().is_some());
    assert_eq!(change["fields"], json!(["display_name"]));
    assert_eq!(change["redacted"], false);
    assert!(!change.to_string().contains("secret-"));
    let restricted = f.without_read();
    let refused = restricted
        .refused(
            restricted
                .send(
                    "ledger-conflict-nonreader",
                    json!({"mode":"stale","value":"private"}),
                )
                .await,
            StatusCode::CONFLICT,
            "stale_revision",
            0,
            2,
        )
        .await;
    assert_eq!(refused["error"]["last_change"], crate::conflict::redacted());
    assert!(!refused.to_string().contains("Newest editor"));
}
