// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
mod registration_checks_support;
use console_entity_application::registration_check::{
    CheckAnswer, CheckKind, FakeRegistrationCheck, UnavailableReason, UserValidation,
};
use registration_checks_support::*;
use sqlx::PgPool;
use std::sync::Arc;

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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn authenticity_and_status_are_independent_current_number_facts(pool: PgPool) {
    let (store, actor, id) = subject(&pool, None).await;
    let mut validated = CheckAnswer::status(BRN, "01");
    validated.kind = CheckKind::Validate;
    validated.valid = Some("01".into());
    validated.response_sha256 = "f".repeat(64);
    let check = store
        .check_registration(
            &common::cmd(&actor),
            id,
            CheckKind::Validate,
            Arc::new(FakeRegistrationCheck::configured(vec![validated.clone()])),
        )
        .await
        .unwrap();
    due(&pool, id).await;
    assert_eq!(
        tick(&pool, &store, &actor, "02", Default::default()).await,
        1
    );
    let current = store.list_entities(&actor, true).await.unwrap().remove(0);
    assert_eq!(
        current.registrations[0].verification_tier, "T2",
        "a scheduled status poll must not erase explicit authenticity evidence"
    );
    assert_eq!(
        current.registrations[0]
            .nts_check
            .as_ref()
            .unwrap()
            .answer
            .status_code
            .as_deref(),
        Some("02")
    );
    validated.valid = Some("02".into());
    validated.status_code = None;
    validated.reported_status = None;
    store
        .check_registration(
            &common::cmd(&actor),
            id,
            CheckKind::Validate,
            Arc::new(FakeRegistrationCheck::configured(vec![validated])),
        )
        .await
        .unwrap();
    assert_eq!(
        store.list_entities(&actor, true).await.unwrap()[0].registrations[0].verification_tier,
        "T1",
        "invalid validation does not erase independent status evidence"
    );
    // Read through an armed transaction for RLS and historical evidence bounds.
    let mut tx = store.pool().begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let known: String = sqlx::query_scalar("SELECT registration_verification_tier($1,$2,$3)")
        .bind(id)
        .bind(BRN)
        .bind(check.checked_at)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(known, "T2");
    let corrected: String =
        sqlx::query_scalar("SELECT registration_verification_tier($1,'0008100071')")
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(corrected, "NONE");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_new_number_can_raise_an_item_and_invalid_validation_does_not_resolve_it(pool: PgPool) {
    let (store, actor, id) = subject(&pool, None).await;
    store
        .check_registration(&common::cmd(&actor), id, CheckKind::Status, fake("02"))
        .await
        .unwrap();
    sqlx::query("UPDATE business_registrations SET brn='0008100071' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let mut answer = CheckAnswer::status("0008100071", "02");
    answer.reported_status = Some(console_entity_domain::codes::OperatingStatus::Suspended);
    answer.response_sha256 = "d".repeat(64);
    store
        .check_registration(
            &common::cmd(&actor),
            id,
            CheckKind::Status,
            Arc::new(FakeRegistrationCheck::configured(vec![answer.clone()])),
        )
        .await
        .unwrap();
    assert_eq!(
        store.registration_check_items(&actor).await.unwrap().len(),
        1
    );
    answer.kind = CheckKind::Validate;
    answer.valid = Some("02".into());
    answer.status_code = None;
    answer.reported_status = None;
    store
        .check_registration(
            &common::cmd(&actor),
            id,
            CheckKind::Validate,
            Arc::new(FakeRegistrationCheck::configured(vec![answer])),
        )
        .await
        .unwrap();
    assert_eq!(
        store.registration_check_items(&actor).await.unwrap().len(),
        1
    );
    let current = store.list_entities(&actor, true).await.unwrap().remove(0);
    assert!(
        current.registrations[0].unverified_reason.is_none(),
        "an invalid answer is already a check; its evidence carries the result"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn changed_consent_values_refuse_before_sending_and_matching_values_are_allowed(
    pool: PgPool,
) {
    let (store, actor, id) = subject(&pool, None).await;
    let values = UserValidation {
        brn: BRN.into(),
        opened_on: "2020-03-02".into(),
        representative: "Changed after consent".into(),
    };
    let error = store
        .check_registration_expected(
            &common::cmd(&actor),
            id,
            CheckKind::Validate,
            Some(values),
            fake("01"),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error,console_entity_adapter_postgres::PgEntityError::Refused(r) if r.code=="stale_revision")
    );
    assert!(
        store
            .registration_checks(&actor, id, 20, None)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    let mut answer = CheckAnswer::status(BRN, "01");
    answer.kind = CheckKind::Validate;
    answer.valid = Some("01".into());
    answer.response_sha256 = "e".repeat(64);
    let current = store.list_entities(&actor, true).await.unwrap().remove(0);
    let values = UserValidation {
        brn: BRN.into(),
        opened_on: "2020-03-02".into(),
        representative: current.current.unwrap().representatives.unwrap()[0].clone(),
    };
    store
        .check_registration_expected(
            &common::cmd(&actor),
            id,
            CheckKind::Validate,
            Some(values),
            Arc::new(FakeRegistrationCheck::configured(vec![answer])),
        )
        .await
        .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reflection_pending_answer_does_not_count_as_agreement(pool: PgPool) {
    let (store, actor, id) = subject(
        &pool,
        Some(time::OffsetDateTime::now_utc().date().to_string()),
    )
    .await;
    store
        .check_registration(&common::cmd(&actor), id, CheckKind::Status, fake("02"))
        .await
        .unwrap();
    store
        .check_registration(&common::cmd(&actor), id, CheckKind::Status, fake(""))
        .await
        .unwrap();
    assert_eq!(
        store.registration_check_items(&actor).await.unwrap().len(),
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refused_external_actions_record_the_purpose_without_personal_values(pool: PgPool) {
    let (store, actor, id) = subject(&pool, None).await;
    let unavailable = Arc::new(FakeRegistrationCheck::unavailable(
        UnavailableReason::ProviderDown,
    ));
    assert!(
        store
            .check_registration(
                &common::cmd(&actor),
                id,
                CheckKind::Validate,
                unavailable.clone()
            )
            .await
            .is_err()
    );
    assert!(
        store
            .preview_registration_check(
                &common::cmd(&actor),
                CheckKind::Validate,
                UserValidation {
                    brn: BRN.into(),
                    opened_on: "2020-03-02".into(),
                    representative: "Private fixture person".into()
                },
                unavailable
            )
            .await
            .is_err()
    );
    let snapshots:Vec<serde_json::Value>=sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='business_registration.check_refused'")
        .bind(actor.org.as_uuid()).fetch_all(&pool).await.unwrap();
    assert_eq!(snapshots.len(), 2);
    for snapshot in snapshots {
        assert_eq!(snapshot["purpose"], "registration_evidence");
        assert_eq!(snapshot["code"], "registration_check_unavailable");
        assert_eq!(
            snapshot["fields_requested"],
            serde_json::json!(["brn", "opened_on", "representative"])
        );
        assert!(!snapshot.to_string().contains("Private fixture person"));
    }
}
