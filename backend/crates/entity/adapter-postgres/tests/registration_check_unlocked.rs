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
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
};
use uuid::Uuid;
type Reply<'a, T> = Pin<Box<dyn Future<Output = Result<T, CheckFailure>> + Send + 'a>>;
struct Unlocked {
    pool: PgPool,
    id: Uuid,
    calls: AtomicUsize,
    answered_micros: AtomicI64,
    during_call: Option<&'static str>,
}
impl Unlocked {
    async fn answer(&self) -> Result<CheckAnswer, CheckFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut tx = self.pool.begin().await.unwrap();
        for sql in [
            "SELECT id FROM business_registrations WHERE id=$1 FOR UPDATE NOWAIT",
            "SELECT registration_id FROM business_registration_check_schedule WHERE registration_id=$1 FOR UPDATE NOWAIT",
        ] {
            sqlx::query(sql)
                .bind(self.id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|_| CheckFailure::Contract {
                    code: "provider_called_with_row_lock",
                })?;
        }
        tx.rollback().await.unwrap();
        if let Some(sql) = self.during_call {
            sqlx::query(sql)
                .bind(self.id)
                .execute(&self.pool)
                .await
                .unwrap();
        }
        let mut answer = CheckAnswer::status(BRN, "01");
        answer.reported_status = Some(console_entity_domain::codes::OperatingStatus::Continuing);
        answer.response_sha256 = "f".repeat(64);
        self.answered_micros.store(
            i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1000).unwrap(),
            Ordering::SeqCst,
        );
        Ok(answer)
    }
}
impl RegistrationCheck for Unlocked {
    fn pack(&self) -> &'static str {
        "KR"
    }
    fn availability(&self) -> CheckAvailability {
        CheckAvailability::available()
    }
    fn reflection_lag_days(&self) -> i64 {
        2
    }
    fn max_batch(&self) -> usize {
        100
    }
    fn status<'a>(&'a self, _: &'a [String]) -> Reply<'a, Vec<CheckAnswer>> {
        Box::pin(async move { Ok(vec![self.answer().await?]) })
    }
    fn validate<'a>(&'a self, _: &'a UserValidation) -> Reply<'a, CheckAnswer> {
        Box::pin(async move {
            let mut answer = self.answer().await?;
            answer.kind = CheckKind::Validate;
            answer.valid = Some("01".into());
            Ok(answer)
        })
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn manual_and_preview_calls_release_locks_and_replay_without_another_http_call(pool: PgPool) {
    let (store, actor, id) = subject(&pool, None).await;
    let port = Arc::new(Unlocked {
        pool: pool.clone(),
        id,
        calls: AtomicUsize::new(0),
        answered_micros: AtomicI64::new(0),
        during_call: None,
    });
    for kind in [CheckKind::Status, CheckKind::Validate] {
        let command = common::cmd(&actor);
        let first = store
            .check_registration(&command, id, kind, port.clone())
            .await
            .unwrap();
        assert!(
            first.checked_at.unix_timestamp_nanos() / 1000
                >= i128::from(port.answered_micros.load(Ordering::SeqCst)),
            "evidence cannot predate the provider answer"
        );
        assert_eq!(
            store
                .check_registration(&command, id, kind, port.clone())
                .await
                .unwrap()
                .id,
            first.id
        );
    }
    let command = common::cmd(&actor);
    let values = UserValidation {
        brn: BRN.into(),
        opened_on: "2020-03-02".into(),
        representative: "홍길동".into(),
    };
    let first = store
        .preview_registration_check(&command, CheckKind::Validate, values.clone(), port.clone())
        .await
        .unwrap();
    assert_eq!(
        store
            .preview_registration_check(&command, CheckKind::Validate, values, port.clone())
            .await
            .unwrap(),
        first
    );
    let checked_at: time::OffsetDateTime = sqlx::query_scalar(
        "SELECT (outcome->>'checked_at')::timestamptz FROM entity_commands WHERE command_id=$1",
    )
    .bind(command.command_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        checked_at.unix_timestamp_nanos() / 1000
            >= i128::from(port.answered_micros.load(Ordering::SeqCst))
    );
    assert_eq!(port.calls.load(Ordering::SeqCst), 3);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_http_releases_claimed_registration_and_schedule_locks(pool: PgPool) {
    let (store, actor, id) = subject(&pool, None).await;
    let port = Arc::new(Unlocked {
        pool: pool.clone(),
        id,
        calls: AtomicUsize::new(0),
        answered_micros: AtomicI64::new(0),
        during_call: None,
    });
    assert_eq!(
        store
            .check_due_registrations(actor.org, port.clone())
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .check_due_registrations(actor.org, port.clone())
            .await
            .unwrap(),
        0
    );
    let check = store
        .registration_checks(&actor, id, 20, None)
        .await
        .unwrap()
        .items
        .remove(0);
    assert!(
        check.checked_at.unix_timestamp_nanos() / 1000
            >= i128::from(port.answered_micros.load(Ordering::SeqCst))
    );
    assert_eq!(port.calls.load(Ordering::SeqCst), 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_number_changed_during_http_cannot_accept_the_old_answer(pool: PgPool) {
    for scheduled in [false, true] {
        let (store, actor, id) = subject(&pool, None).await;
        let port = Arc::new(Unlocked {
            pool: pool.clone(),
            id,
            calls: AtomicUsize::new(0),
            answered_micros: AtomicI64::new(0),
            during_call: Some("UPDATE business_registrations SET brn='0008100071' WHERE id=$1"),
        });
        if scheduled {
            assert_eq!(
                store
                    .check_due_registrations(actor.org, port)
                    .await
                    .unwrap(),
                0
            );
        } else {
            let error = store
                .check_registration(&common::cmd(&actor), id, CheckKind::Status, port)
                .await
                .unwrap_err();
            assert!(
                matches!(error, console_entity_adapter_postgres::PgEntityError::Refused(r) if r.code == "stale_revision")
            );
        }
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
async fn a_partial_daily_budget_leaves_unclaimed_registrations_due(pool: PgPool) {
    let (store, actor, id) = subject(&pool, None).await;
    let entity = store
        .create_entity(
            &common::cmd(&actor),
            common::corporation("예산 법인", "000211-0006241"),
        )
        .await
        .unwrap()
        .record;
    store
        .create_registration(
            &common::cmd(&actor),
            entity.id,
            common::certificate("0008100071"),
        )
        .await
        .unwrap();
    sqlx::query("INSERT INTO registration_check_daily_budget(day,attempts) VALUES((now() AT TIME ZONE 'UTC')::date,1)").execute(&pool).await.unwrap();
    let policy = console_entity_adapter_postgres::CheckSchedulePolicy {
        daily_budget: 2,
        ..Default::default()
    };
    set_policy(&pool, policy).await;
    let port = Arc::new(Unlocked {
        pool: pool.clone(),
        id,
        calls: AtomicUsize::new(0),
        answered_micros: AtomicI64::new(0),
        during_call: None,
    });
    assert_eq!(
        store
            .check_due_registrations(actor.org, port)
            .await
            .unwrap(),
        1
    );
    let due_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM business_registration_check_schedule WHERE due_at<=now()",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(due_count, 1);
    let used: i64 = sqlx::query_scalar("SELECT attempts FROM registration_check_daily_budget")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(used, 2);
}
