// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
mod registration_checks_support;
use console_entity_application::registration_check::{
    CheckAnswer, CheckKind, FakeRegistrationCheck, UserValidation,
};
use registration_checks_support::*;
use sqlx::PgPool;
use std::sync::Arc;

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
