// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
mod registration_checks_support;
use console_entity_adapter_postgres::PgEntityError;
use console_entity_application::registration_check::{
    CheckKind, PreviewAcceptance, UserValidation,
};
use console_entity_domain::codes::OperatingStatus;
use registration_checks_support::*;
use sqlx::PgPool;
use uuid::Uuid;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn closed_preview_requires_acknowledgment_then_records_reported_close_date(pool: PgPool) {
    let (store, actor) = common::tenant(&pool, Uuid::new_v4(), "nts-preview").await;
    let entity = store
        .create_entity(
            &common::cmd(&actor),
            common::corporation("폐업 확인 법인", "0002119999918"),
        )
        .await
        .unwrap()
        .record
        .id;
    let command = common::cmd(&actor);
    let answer = store
        .preview_registration_check(
            &command,
            CheckKind::Status,
            UserValidation {
                brn: BRN.into(),
                opened_on: "2020-03-02".into(),
                representative: "홍길동".into(),
            },
            fake("03"),
        )
        .await
        .unwrap();
    assert_eq!(answer.reported_status, Some(OperatingStatus::Closed));
    let checked_at:time::OffsetDateTime=sqlx::query_scalar("UPDATE entity_commands SET outcome=outcome || jsonb_build_object('checked_at',now()-interval '1 hour') WHERE command_id=$1 RETURNING (outcome->>'checked_at')::timestamptz").bind(command.command_id).fetch_one(&pool).await.unwrap();
    let preview: PreviewAcceptance = serde_json::from_value(serde_json::json!({
        "command_id":command.command_id.unwrap(), "acknowledged":false, "status_since":null
    }))
    .unwrap();
    let refused = store
        .create_registration_checked(
            &common::cmd(&actor),
            entity,
            common::certificate(BRN),
            None,
            Some(preview.clone()),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(refused, PgEntityError::Refused(r) if r.code=="validation_failed" && r.fields.iter().any(|f|f.field=="check_preview.acknowledged"&&f.code=="required"))
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM business_registrations WHERE org_id=$1")
            .bind(actor.org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let saved = store
        .create_registration_checked(
            &common::cmd(&actor),
            entity,
            common::certificate(BRN),
            None,
            Some(PreviewAcceptance {
                acknowledged: true,
                ..preview
            }),
        )
        .await
        .unwrap()
        .record;
    assert_eq!(
        saved.current.as_ref().unwrap().status,
        OperatingStatus::Closed
    );
    assert_eq!(saved.closed_on.unwrap().to_string(), "2026-09-30");
    assert_eq!(saved.nts_check.as_ref().unwrap().checked_at, checked_at);
    assert_eq!(
        saved
            .current
            .as_ref()
            .unwrap()
            .status_since
            .unwrap()
            .to_string(),
        "2026-09-30"
    );
    assert_eq!(
        saved.nts_check.unwrap().answer.end_dt.as_deref(),
        Some("20260930")
    );
}
