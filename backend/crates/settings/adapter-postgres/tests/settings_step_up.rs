// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use console_kernel_core::KernelError;
use console_settings_adapter_postgres::settings_change_payload;
use console_settings_application::ChangeSetting;
use console_settings_domain::{Direction, SettingKey, SettingValue};
use serde_json::json;
use settings_support::*;
use sha2::Digest;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn random_uuid_step_up_is_refused_for_loosening_and_writes_no_row(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let later = OffsetDateTime::now_utc() + Duration::hours(24);
    let cmd = ChangeSetting {
        key: KEY.to_owned(),
        scope_entity_id: None,
        value: json!(60),
        effective_from: Some(later),
        reason_code: "POLICY_REVIEW".to_owned(),
        reason_note: None,
        expected_version: None,
        step_up_assertion_id: Some(Uuid::new_v4()),
    };
    let err = store
        .change_setting(actor, cmd, audit(), |facts| {
            if facts.direction == Direction::Loosen && !facts.step_up {
                return Err(
                    KernelError::forbidden("loosening a setting requires passkey step-up")
                        .with_code("step_up_required"),
                );
            }
            Ok(())
        })
        .await
        .unwrap_err();
    assert_eq!(err_code(&err), "step_up_required");

    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1")
            .bind(actor.org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn real_settings_change_step_up_permits_loosening_and_writes_row(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let later = OffsetDateTime::now_utc() + Duration::hours(24);
    let ceremony_id = Uuid::new_v4();
    let key: SettingKey = KEY.parse().unwrap();
    let val = SettingValue::Int(60);
    let payload = settings_change_payload(key, &val);
    let payload_hash = hex::encode(sha2::Sha256::digest(payload.as_bytes()));

    // Seed the verified step_up_assertion
    sqlx::query(
        "INSERT INTO step_up_assertions (ceremony_id, org_id, user_id, credential_row_id, action_kind, object_id, payload_hash, user_verified)
         VALUES ($1, $2, $3, $4, 'SETTINGS_CHANGE', $5, $6, true)",
    )
    .bind(ceremony_id)
    .bind(actor.org.as_uuid())
    .bind(actor.user.as_uuid())
    .bind(Uuid::new_v4())
    .bind(Uuid::nil())
    .bind(payload_hash)
    .execute(&pool)
    .await
    .unwrap();

    let cmd = ChangeSetting {
        key: KEY.to_owned(),
        scope_entity_id: None,
        value: json!(60),
        effective_from: Some(later),
        reason_code: "POLICY_REVIEW".to_owned(),
        reason_note: None,
        expected_version: None,
        step_up_assertion_id: Some(ceremony_id),
    };
    let view = store
        .change_setting(actor, cmd, audit(), |facts| {
            assert!(facts.step_up);
            assert_eq!(facts.direction, Direction::Loosen);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(view.direction, Direction::Loosen);

    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1")
            .bind(actor.org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1);

    let saved_ceremony: Option<Uuid> = sqlx::query_scalar(
        "SELECT step_up_assertion_id FROM tenant_setting_overrides WHERE org_id = $1",
    )
    .bind(actor.org.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(saved_ceremony, Some(ceremony_id));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_reason_code_is_refused_and_writes_no_row(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let cmd = ChangeSetting {
        key: KEY.to_owned(),
        scope_entity_id: None,
        value: json!(20),
        effective_from: None,
        reason_code: "UNKNOWN_REASON_CODE".to_owned(),
        reason_note: None,
        expected_version: None,
        step_up_assertion_id: None,
    };
    let err = store
        .change_setting(actor, cmd, audit(), |_| Ok(()))
        .await
        .unwrap_err();
    assert_eq!(err_code(&err), "reason_code_invalid");

    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1")
            .bind(actor.org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tightening_does_not_persist_an_unverified_step_up_id(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let mut cmd = change(json!(20), None);
    cmd.step_up_assertion_id = Some(Uuid::new_v4());
    let view = store
        .change_setting(actor, cmd, audit(), |facts| {
            assert!(!facts.step_up);
            Ok(())
        })
        .await
        .unwrap();
    let saved: Option<Uuid> = sqlx::query_scalar(
        "SELECT step_up_assertion_id FROM tenant_setting_overrides WHERE org_id=$1 AND id=$2",
    )
    .bind(actor.org.as_uuid())
    .bind(view.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(saved, None);
}
