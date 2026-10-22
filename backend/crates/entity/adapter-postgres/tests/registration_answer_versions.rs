// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
mod registration_answer_support;
use common::*;
use console_entity_application::WorkplaceRevision;
use console_entity_domain::legal_entity::CodeInput;
use registration_answer_support::*;
use sqlx::PgPool;
use uuid::Uuid;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_and_retired_reason_values_are_stable_refusals_with_no_row(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "registration-reason-refusal").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    for (code_value, version, refusal) in [
        ("NO_SUCH_REASON", "2026-10-22", "invalid_option"),
        ("VAT_DEPOT", "2026-10-21", "reference_version_retired"),
    ] {
        let mut input = not_registered("거절 대상", false);
        input.input.not_registered_reason = Some(CodeInput {
            code: Some(code_value.into()),
            version: Some(version.into()),
        });
        let error = store
            .create_workplace_with_references(&cmd(&actor), entity, input, port(), Some(resolve))
            .await
            .unwrap_err();
        assert_eq!(
            code(error).1,
            vec![("not_registered_reason".into(), refusal)]
        );
    }
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workplaces WHERE legal_entity_id = $1")
            .bind(entity)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(rows, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unchanged_retired_answer_preserves_its_stamp_but_a_new_retired_pick_is_refused(
    owner: PgPool,
) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "stored-reason-version").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let wp = store
        .create_workplace_with_references(
            &cmd(&actor),
            entity,
            not_registered("하치장", false),
            port(),
            Some(resolve),
        )
        .await
        .unwrap()
        .record;
    sqlx::query("UPDATE workplaces SET not_registered_reason_version = '2026-10-21', not_registered_reason_label = '기록 당시 하치장' WHERE id = $1").bind(wp.id).execute(&owner).await.unwrap();
    let mut input = not_registered("하치장 연락처 변경", false).input;
    input.not_registered_reason.as_mut().unwrap().version = Some("2026-10-21".into());
    input.status = Some("CONTINUING".into());
    let revision = WorkplaceRevision {
        expected_version: Some(1),
        effective_from: Some("2026-01-01".into()),
        reason_code: Some("CONTACT_CHANGED".into()),
        input,
    };
    let revised = store
        .revise_workplace_with_references(
            &cmd(&actor),
            wp.id,
            revision.clone(),
            port(),
            Some(resolve),
        )
        .await
        .unwrap()
        .record;
    let reason = revised.not_registered_reason.unwrap();
    assert_eq!(reason.version, "2026-10-21");
    assert_eq!(reason.label, "기록 당시 하치장");
    let mut changed = revision;
    changed.expected_version = Some(2);
    changed.input.not_registered_reason.as_mut().unwrap().code = Some("REMOTE_TELEWORK".into());
    assert_eq!(
        code(
            store
                .revise_workplace_with_references(
                    &cmd(&actor),
                    wp.id,
                    changed,
                    port(),
                    Some(resolve)
                )
                .await
                .unwrap_err()
        )
        .1,
        vec![("not_registered_reason".into(), "reference_version_retired")]
    );
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workplace_revisions WHERE workplace_id = $1")
            .bind(wp.id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(rows, 2);
}
