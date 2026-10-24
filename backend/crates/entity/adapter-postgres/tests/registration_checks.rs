// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
mod registration_checks_support;
use console_entity_adapter_postgres::CheckSchedulePolicy;
use console_entity_application::{
    RegistrationRevision, RegistrationStatusInput,
    registration_check::{CheckAnswer, CheckKind, FakeRegistrationCheck, RegistrationCheckInbox},
};
use console_entity_domain::codes::OperatingStatus;
use registration_checks_support::*;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn evidence_replay_deduplication_and_inbox_source_never_overwrite_recorded_status(
    pool: PgPool,
) {
    let (store, actor, id) = subject(&pool, None).await;
    let command = common::cmd(&actor);
    let first = store
        .check_registration(&command, id, CheckKind::Status, fake("02"))
        .await
        .unwrap();
    let cadence = i32::try_from(CheckSchedulePolicy::default().cadence_hours).unwrap();
    let deferred: bool = sqlx::query_scalar("SELECT s.due_at=c.checked_at+make_interval(hours=>$2) FROM business_registration_check_schedule s JOIN business_registration_checks c ON c.registration_id=s.registration_id WHERE c.id=$1")
        .bind(first.id).bind(cadence).fetch_one(&pool).await.unwrap();
    assert!(
        deferred,
        "a fresh manual check starts the configured schedule cadence"
    );
    assert!(first.recorded_status_mismatch);
    assert_eq!(
        first.id,
        store
            .check_registration(&command, id, CheckKind::Status, fake("02"))
            .await
            .unwrap()
            .id
    );
    assert_eq!(
        store
            .registration_checks(&actor, id, 20, None)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    store
        .check_registration(&common::cmd(&actor), id, CheckKind::Status, fake("02"))
        .await
        .unwrap();
    let source: &dyn RegistrationCheckInbox = &store;
    let items = source.list_check_items(&actor).await.unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(Some(items[0].id), first.inbox_item_id);
    assert_eq!(items[0].registration_id, id);
    let read = store.list_entities(&actor, true).await.unwrap();
    assert_eq!(
        read[0].registrations[0].current.as_ref().unwrap().status,
        OperatingStatus::Continuing
    );
    assert_eq!(read[0].registrations[0].verification_tier, "T1");
    store
        .check_registration(&common::cmd(&actor), id, CheckKind::Status, fake("01"))
        .await
        .unwrap();
    assert!(source.list_check_items(&actor).await.unwrap().is_empty());
    assert_eq!(
        store
            .registration_checks(&actor, id, 20, None)
            .await
            .unwrap()
            .items
            .len(),
        3
    );
    store
        .check_registration(&common::cmd(&actor), id, CheckKind::Status, fake("02"))
        .await
        .unwrap();
    store
        .revise_registration(
            &common::cmd(&actor),
            id,
            RegistrationRevision {
                expected_version: Some(1),
                effective_from: Some(time::OffsetDateTime::now_utc().date().to_string()),
                reason_code: Some("CORRECTION".into()),
                input: common::certificate(BRN),
            },
            RegistrationStatusInput {
                status: Some("SUSPENDED".into()),
                status_since: Some(time::OffsetDateTime::now_utc().date().to_string()),
                status_until: None,
            },
        )
        .await
        .unwrap();
    assert!(source.list_check_items(&actor).await.unwrap().is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn append_only_rls_and_current_number_derivation_preserve_old_evidence(pool: PgPool) {
    let (store, actor, id) = subject(&pool, None).await;
    let check = store
        .check_registration(&common::cmd(&actor), id, CheckKind::Status, fake("01"))
        .await
        .unwrap();
    let before = evidence(&pool, id).await;
    for statement in [
        "UPDATE business_registration_checks SET provider_version='changed' WHERE id=$1",
        "DELETE FROM business_registration_checks WHERE id=$1",
    ] {
        let error = sqlx::query(statement)
            .bind(check.id)
            .execute(&pool)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("append-only"), "{error}");
    }
    let (_, other) = common::tenant(&pool, Uuid::new_v4(), "nts-other").await;
    let mut tx = store.pool().begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(other.org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM business_registration_checks WHERE registration_id=$1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(count, 0);
    tx.rollback().await.unwrap();
    assert!(
        store
            .registration_checks(&other, id, 20, None)
            .await
            .is_err()
    );
    sqlx::query("UPDATE business_registrations SET brn='0008100071' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let read = store.list_entities(&actor, true).await.unwrap();
    assert_eq!(read[0].registrations[0].verification_tier, "NONE");
    assert_eq!(
        read[0].registrations[0].unverified_reason.unwrap().as_str(),
        "NOT_CHECKED"
    );
    assert!(read[0].registrations[0].nts_check.is_none());
    assert_eq!(evidence(&pool, id).await, before);
    let history = store
        .registration_checks(&actor, id, 20, None)
        .await
        .unwrap();
    assert_eq!(history.items.len(), 1);
    assert!(history.latest_status.is_none());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn schedule_claims_skip_locked_respect_budget_and_use_configured_cadence(pool: PgPool) {
    let (store, actor, id) = subject(&pool, None).await;
    let policy = CheckSchedulePolicy {
        cadence_hours: 7,
        batch_size: 1,
        daily_budget: 2,
        ..CheckSchedulePolicy::default()
    };
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT registration_id FROM business_registration_check_schedule WHERE registration_id=$1 FOR UPDATE").bind(id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(tick(&store, &actor, "02", policy).await, 0);
    tx.rollback().await.unwrap();
    let mut forbidden = CheckAnswer::status(BRN, "01");
    forbidden.kind = CheckKind::Validate;
    forbidden.valid = Some("01".into());
    forbidden.response_sha256 = "c".repeat(64);
    assert!(
        store
            .check_due_registrations(
                actor.org,
                Arc::new(FakeRegistrationCheck::configured(vec![forbidden])),
                policy
            )
            .await
            .is_err()
    );
    // The provider attempt spends budget even when its answer violates the contract.
    due(&pool, id).await;
    assert_eq!(tick(&store, &actor, "02", policy).await, 1);
    assert_eq!(tick(&store, &actor, "02", policy).await, 0);
    let row = store
        .registration_checks(&actor, id, 20, None)
        .await
        .unwrap()
        .items
        .remove(0);
    assert_eq!(row.trigger, "SCHEDULE");
    assert_eq!(row.answer.kind, CheckKind::Status);
    assert_eq!(row.answer.fields_sent, ["b_no"]);
    assert_eq!(row.actor_id, None);
    let hours: f64 = sqlx::query_scalar("SELECT extract(epoch FROM (due_at-now()))::float8/3600 FROM business_registration_check_schedule WHERE registration_id=$1").bind(id).fetch_one(&pool).await.unwrap();
    assert!((6.9..=7.0).contains(&hours));
    due(&pool, id).await;
    assert_eq!(tick(&store, &actor, "01", policy).await, 0);
    let policy = CheckSchedulePolicy {
        daily_budget: 3,
        cadence_hours: 3,
        ..policy
    };
    assert_eq!(tick(&store, &actor, "01", policy).await, 1);
    assert!(
        store
            .registration_check_items(&actor)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .registration_checks(&actor, id, 20, None)
            .await
            .unwrap()
            .items
            .len(),
        2
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unregistered_numbers_honor_reflection_lag_then_open_exactly_one_item(pool: PgPool) {
    let yesterday = (time::OffsetDateTime::now_utc() - time::Duration::days(1))
        .date()
        .to_string();
    let (recent, recent_actor, recent_id) = subject(&pool, Some(yesterday)).await;
    let policy = CheckSchedulePolicy::default();
    assert_eq!(tick(&recent, &recent_actor, "", policy).await, 1);
    assert!(
        recent
            .registration_check_items(&recent_actor)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        recent
            .registration_checks(&recent_actor, recent_id, 20, None)
            .await
            .unwrap()
            .items[0]
            .reflection_pending
    );
    let (store, actor, id) = subject(&pool, None).await;
    assert_eq!(tick(&store, &actor, "", policy).await, 1);
    assert_eq!(
        store.registration_check_items(&actor).await.unwrap().len(),
        1
    );
    due(&pool, id).await;
    tick(&store, &actor, "", policy).await;
    assert_eq!(
        store.registration_check_items(&actor).await.unwrap().len(),
        1
    );
    let record = &store.list_entities(&actor, true).await.unwrap()[0].registrations[0];
    assert_eq!(record.verification_tier, "NONE");
    assert_eq!(
        record.current.as_ref().unwrap().status,
        OperatingStatus::Continuing
    );
}
