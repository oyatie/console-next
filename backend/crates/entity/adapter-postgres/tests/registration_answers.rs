// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
mod registration_answer_support;
use common::*;
use console_entity_application::WorkplaceRevision;
use registration_answer_support::*;
use sqlx::PgPool;
use uuid::Uuid;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn abstract_and_exempt_registration_answers_are_safe_to_revise_and_attach(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "registration-answer").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let registration = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;

    let abstract_workplace = store
        .create_workplace_with_references(
            &cmd(&actor),
            entity,
            not_registered("주소 없는 묶음", true),
            port(),
            Some(resolve),
        )
        .await
        .unwrap()
        .record;
    let stored_address: Option<Uuid> = sqlx::query_scalar(
        "SELECT address_id FROM workplace_revisions WHERE workplace_id = $1 AND version = 1",
    )
    .bind(abstract_workplace.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        stored_address, None,
        "the migration accepts an abstract revision"
    );
    let ledger_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workplace_registration_changes WHERE workplace_id = $1",
    )
    .bind(abstract_workplace.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    let refused = store
        .change_workplace_registration(
            &cmd(&actor),
            abstract_workplace.id,
            change(registration, None, "2026-01-01"),
        )
        .await
        .unwrap_err();
    assert_eq!(
        code(refused).1,
        vec![(
            "registration_id".into(),
            "abstract_workplace_not_registrable"
        )]
    );
    let ledger_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workplace_registration_changes WHERE workplace_id = $1",
    )
    .bind(abstract_workplace.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        ledger_after, ledger_before,
        "a refusal writes no change row"
    );

    let exempt = store
        .create_workplace_with_references(
            &cmd(&actor),
            entity,
            not_registered("물류 하치장", false),
            port(),
            Some(resolve),
        )
        .await
        .unwrap()
        .record;
    let current = exempt.current.as_ref().unwrap();
    let mut revise = not_registered("물류 하치장 (정정)", false).input;
    revise.status = Some("CONTINUING".into());
    let revised = store
        .revise_workplace_with_references(
            &cmd(&actor),
            exempt.id,
            WorkplaceRevision {
                expected_version: Some(current.version),
                effective_from: Some("2026-01-01".into()),
                reason_code: Some("CONTACT_CHANGED".into()),
                input: revise,
            },
            port(),
            Some(resolve),
        )
        .await
        .unwrap()
        .record;
    assert_eq!(
        revised.not_registered_reason.as_ref().unwrap().code,
        "VAT_DEPOT"
    );
    assert!(!revised.is_abstract);
    let structure = store.org_structure(&actor).await.unwrap();
    for workplace in [abstract_workplace.id, exempt.id] {
        let node = structure.entities[0]
            .children
            .iter()
            .find(|node| node.id == workplace)
            .unwrap();
        assert!(!node.chips.contains(&"registration_missing"));
    }

    let attached = store
        .change_workplace_registration(
            &cmd(&actor),
            exempt.id,
            change(registration, None, "2026-01-01"),
        )
        .await
        .unwrap()
        .record;
    assert_eq!(attached.registration_id, Some(registration));
    assert_eq!(attached.not_registered_reason, None);
    assert_eq!(
        attached.current.as_ref().unwrap().not_registered_reason,
        None
    );
    let mut input = workplace_from(registration, "물류 하치장 (연결 후 정정)").input;
    input.status = Some("CONTINUING".into());
    store
        .revise_workplace_with_references(
            &cmd(&actor),
            exempt.id,
            WorkplaceRevision {
                expected_version: Some(attached.current.as_ref().unwrap().version),
                effective_from: Some("2026-01-01".into()),
                reason_code: Some("CONTACT_CHANGED".into()),
                input,
            },
            port(),
            Some(resolve),
        )
        .await
        .unwrap();
    let ledger: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT from_not_registered_reason_code, to_not_registered_reason_code \
         FROM workplace_registration_changes WHERE workplace_id = $1",
    )
    .bind(exempt.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(ledger, (Some("VAT_DEPOT".into()), None));
    let answer_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE target_id IN ($1, $2) \
         AND action = 'workplace.registration_answer.changed'",
    )
    .bind(abstract_workplace.id.to_string())
    .bind(exempt.id.to_string())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        answer_events, 3,
        "create twice and attach once; rename is not an answer change"
    );
}
