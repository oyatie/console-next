// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A removal still displays the people from the previous revision.
mod common;
use common::{certificate, cmd, corporation, port, tenant, workplace_from};
use console_entity_application::{
    LegalEntityRevision, WORKPLACE_PERSONAL_FIELDS, WorkplaceRevision,
    workplace_personal_field_is_present,
};
use console_entity_domain::legal_entity::DirectorInput;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_classification_drives_masking_and_subjects_without_drift(pool: PgPool) {
    let classified: Vec<String> = sqlx::query_scalar("SELECT attname::text FROM pg_attribute WHERE attrelid='workplace_revisions'::regclass AND attnum>0 AND NOT attisdropped AND col_description(attrelid,attnum) LIKE 'pd:personal%' AND attname<>'actor_id' ORDER BY attname")
        .fetch_all(&pool).await.unwrap();
    let mut fields: Vec<_> = WORKPLACE_PERSONAL_FIELDS
        .iter()
        .map(|field| field.name())
        .collect();
    fields.sort();
    assert_eq!(
        fields, classified,
        "every non-bookkeeping personal column must enter the shared classification"
    );
    let (store, actor) = tenant(&pool, Uuid::new_v4(), "workplace-classification").await;
    let entity = store
        .create_entity(
            &cmd(&actor),
            corporation("Classification", "000211-0006241"),
        )
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
    let today: time::Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&pool)
        .await
        .unwrap();
    let values = json!({"representative_name":"사업장 대표자", "mobile":"010-1234-5678", "email":"workplace@example.com"});
    for field in WORKPLACE_PERSONAL_FIELDS {
        let mut input = workplace_from(registration, field.name());
        input.input.status = Some("CONTINUING".into());
        let mut data = json!(input.input);
        assert!(
            !values[field.name()].is_null(),
            "add a discriminating fixture for {}",
            field.name()
        );
        data[field.name()] = values[field.name()].clone();
        input.input = serde_json::from_value(data).unwrap();
        let workplace = store
            .create_workplace(&cmd(&actor), entity, input.clone(), port())
            .await
            .unwrap()
            .record;
        let state = workplace.current.as_ref().unwrap();
        assert!(
            workplace_personal_field_is_present(*field, state),
            "{} alone identifies a subject",
            field.name()
        );
        let masked = store
            .get_entity(&actor, entity, false)
            .await
            .unwrap()
            .workplaces
            .into_iter()
            .find(|item| item.id == workplace.id)
            .unwrap();
        assert!(json!(masked.current)[field.name()].is_null());
        assert!(WORKPLACE_PERSONAL_FIELDS.iter().all(
            |field| !workplace_personal_field_is_present(*field, masked.current.as_ref().unwrap())
        ));
        let history = store
            .workplace_history(&actor, workplace.id, true)
            .await
            .unwrap();
        assert!(history.iter().any(|entry| {
            entry
                .subject_refs
                .contains(&format!("workplace_revisions:{}:1", workplace.id))
        }));
        let masked = store
            .workplace_history(&actor, workplace.id, false)
            .await
            .unwrap();
        assert!(masked.iter().all(|entry| {
            entry
                .changes
                .iter()
                .all(|change| !fields.contains(&change.field.as_str()))
        }));
        let mut removed = json!(input.input);
        removed[field.name()] = serde_json::Value::Null;
        store
            .revise_workplace(
                &cmd(&actor),
                workplace.id,
                WorkplaceRevision {
                    expected_version: Some(1),
                    effective_from: Some(today.to_string()),
                    reason_code: Some("CORRECTION".into()),
                    input: serde_json::from_value(removed).unwrap(),
                },
                port(),
            )
            .await
            .unwrap();
        let history = store
            .workplace_history(&actor, workplace.id, true)
            .await
            .unwrap();
        assert!(
            history[0]
                .subject_refs
                .contains(&format!("workplace_revisions:{}:1", workplace.id)),
            "removal returns the previous personal value"
        );
        assert!(
            !history[0]
                .subject_refs
                .contains(&format!("workplace_revisions:{}:2", workplace.id)),
            "empty revision returns no personal value"
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn removed_director_remains_a_subject_of_the_removal_entry(pool: PgPool) {
    let (store, actor) = tenant(&pool, Uuid::new_v4(), "history-removal").await;
    let mut original = corporation("Removal history", "000211-0006241");
    original.directors = Some(vec![DirectorInput {
        role: Some("AUDITOR".into()),
        name: Some("이전 감사".into()),
        ..Default::default()
    }]);
    let entity = store
        .create_entity(&cmd(&actor), original.clone())
        .await
        .unwrap()
        .record;
    let today: time::Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&pool)
        .await
        .unwrap();
    original.directors = Some(vec![]);
    store
        .revise_entity(
            &cmd(&actor),
            entity.id,
            LegalEntityRevision {
                expected_version: Some(1),
                effective_from: Some(today.to_string()),
                reason_code: Some("CORRECTION".into()),
                input: original,
            },
        )
        .await
        .unwrap();
    let history = store.entity_history(&actor, entity.id, true).await.unwrap();
    let removal = &history[0];
    assert_eq!(removal.version, 2);
    let change = removal
        .changes
        .iter()
        .find(|c| c.field == "directors")
        .unwrap();
    assert!(json!(change).to_string().contains("이전 감사"));
    assert!(
        removal
            .subject_refs
            .contains(&format!("legal_entity_directors:{}:1:1", entity.id)),
        "the before side's person is returned by this removal entry"
    );
    assert!(
        !removal
            .subject_refs
            .contains(&format!("legal_entity_directors:{}:2:1", entity.id))
    );
}
