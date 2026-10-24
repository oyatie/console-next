// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
mod registration_checks_support;
use console_entity_application::registration_check::*;
use registration_checks_support::*;
use sqlx::PgPool;
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
type Reply<'a, T> = Pin<Box<dyn Future<Output = Result<T, CheckFailure>> + Send + 'a>>;
struct FailedCall(AtomicUsize);
impl RegistrationCheck for FailedCall {
    fn pack(&self) -> &'static str {
        "KR"
    }
    fn reflection_lag_days(&self) -> i64 {
        2
    }
    fn max_batch(&self) -> usize {
        100
    }
    fn availability(&self) -> CheckAvailability {
        CheckAvailability::available()
    }
    fn status<'a>(&'a self, _: &'a [String]) -> Reply<'a, Vec<CheckAnswer>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(CheckFailure::Unavailable(UnavailableReason::ProviderDown)) })
    }
    fn validate<'a>(&'a self, _: &'a UserValidation) -> Reply<'a, CheckAnswer> {
        unreachable!("the schedule must only request status")
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_failed_provider_call_commits_backoff_without_evidence_or_an_immediate_retry(
    pool: PgPool,
) {
    let (store, actor, id) = subject(&pool, None).await;
    let port = Arc::new(FailedCall(AtomicUsize::new(0)));
    for (attempt, backoff_seconds) in [(1, 120), (2, 180)] {
        let policy = console_entity_adapter_postgres::CheckSchedulePolicy {
            backoff_seconds,
            ..Default::default()
        };
        set_policy(&pool, policy).await;
        due(&pool, id).await;
        let before: time::OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            store
                .check_due_registrations(actor.org, port.clone())
                .await
                .unwrap(),
            0
        );
        let after: time::OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let due: time::OffsetDateTime = sqlx::query_scalar(
            "SELECT due_at FROM business_registration_check_schedule WHERE registration_id=$1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let delay = time::Duration::seconds(policy.backoff_seconds);
        assert!(
            due >= before + delay && due <= after + delay,
            "failed calls must defer the next attempt by the configured backoff"
        );
        assert_eq!(
            store
                .check_due_registrations(actor.org, port.clone())
                .await
                .unwrap(),
            0
        );
        assert_eq!(port.0.load(Ordering::SeqCst), attempt);
        assert!(
            store
                .registration_checks(&actor, id, 20, None)
                .await
                .unwrap()
                .items
                .is_empty()
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registry_changes_control_manual_and_scheduled_cadence_without_code_changes(pool: PgPool) {
    let (store, actor, id) = subject(&pool, None).await;
    for cadence_hours in [7, 3] {
        set_policy(
            &pool,
            console_entity_adapter_postgres::CheckSchedulePolicy {
                cadence_hours,
                ..Default::default()
            },
        )
        .await;
        let check = store
            .check_registration(&common::cmd(&actor), id, CheckKind::Status, fake("01"))
            .await
            .unwrap();
        let next: time::OffsetDateTime = sqlx::query_scalar(
            "SELECT due_at FROM business_registration_check_schedule WHERE registration_id=$1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            next,
            check.checked_at + time::Duration::hours(cadence_hours)
        );
        due(&pool, id).await;
        let before: time::OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            store
                .check_due_registrations(actor.org, fake("01"))
                .await
                .unwrap(),
            1
        );
        let next: time::OffsetDateTime = sqlx::query_scalar(
            "SELECT due_at FROM business_registration_check_schedule WHERE registration_id=$1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let cadence = time::Duration::hours(cadence_hours);
        assert!(
            next >= before + cadence
                && next
                    <= sqlx::query_scalar::<_, time::OffsetDateTime>("SELECT clock_timestamp()")
                        .fetch_one(&pool)
                        .await
                        .unwrap()
                        + cadence
        );
    }
}
