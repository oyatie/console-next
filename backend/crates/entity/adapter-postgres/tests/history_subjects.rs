// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A removal still displays the people from the previous revision.
mod common;
use common::{cmd, corporation, tenant};
use console_entity_application::LegalEntityRevision;
use console_entity_domain::legal_entity::DirectorInput;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

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
