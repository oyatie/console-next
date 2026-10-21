#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 등록증 재발급·정정 after 운영 시작: governed (change mode GOVERNED) and
//! audited, the revision still naming its certificate.

mod common;
mod reissue_support;

use common::*;
use reissue_support::*;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn after_go_live_the_reissue_is_governed(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "C").await;
    let (entity, reg, _) = setup(&store, &actor).await;
    set_operating(&owner, ORG).await;
    let second = upload(&store, &actor, "v2").await;
    let body = moved(&store, &actor, entity, reg, Some(second)).await;
    let saved = store
        .reissue_registration(&cmd(&actor), reg, body)
        .await
        .unwrap();
    assert_eq!(saved.change_mode, "GOVERNED");
    let top = &store.registration_history(&actor, reg, true).await.unwrap()[0];
    assert_eq!(
        (top.change_mode.as_str(), top.evidence_document_id),
        ("GOVERNED", Some(second))
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'business_registration.reissue' AND target_id = $1",
    )
    .bind(reg.to_string())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audited, 1);
}
