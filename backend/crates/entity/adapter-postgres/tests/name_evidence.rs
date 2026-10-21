#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Runtime-role refusals and dated certificate/name evidence, from an empty tenant.
mod common;
mod corrections_support;
use common::*;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn person_names_are_refused_without_entity_or_audit_side_effects(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "names-refusal").await;
    for name in ["홍길동", "김예시,박예시"] {
        let refusal = code(
            store
                .create_entity(&cmd(&actor), corporation(name, "000211-0006241"))
                .await
                .unwrap_err(),
        );
        assert_eq!(refusal.0, "validation_failed");
        assert!(refusal.1.contains(&("name".into(), "legal_name_is_person")));
        // The 약칭 and the 영문명 are guarded the same way, each with its own pointer.
        let mut input = corporation("주식회사 누리", "000211-0006241");
        input.display_name = Some(name.into());
        let refusal = code(store.create_entity(&cmd(&actor), input).await.unwrap_err());
        assert_eq!(
            refusal.1,
            [("display_name".to_owned(), "display_name_is_person")]
        );
    }
    let mut input = corporation("주식회사 누리", "000211-0006241");
    input.english_name = Some(Some("Hong Gildong".into()));
    input.representatives = vec!["Hong Gildong".into()];
    let refusal = code(store.create_entity(&cmd(&actor), input).await.unwrap_err());
    assert_eq!(
        refusal.1,
        [("english_name".to_owned(), "english_name_is_person")]
    );
    let mut input = corporation("주식회사 누리", "000211-0006241");
    input.english_name = Some(Some("누리 Co., Ltd.".into()));
    input.display_name = Some("가".repeat(41));
    let refusal = code(store.create_entity(&cmd(&actor), input).await.unwrap_err());
    assert!(
        refusal
            .1
            .contains(&("english_name".into(), "english_name_not_latin")),
        "{refusal:?}"
    );
    assert!(
        refusal.1.iter().any(|(f, _)| f == "display_name"),
        "{refusal:?}"
    );
    let entities: i64 = sqlx::query_scalar("SELECT count(*) FROM legal_entities WHERE org_id = $1")
        .bind(org)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(entities, 0);
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'legal_entity.create'",
    )
    .bind(org)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audits, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn branch_primary_and_wrong_kind_need_an_explicit_reason(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "brn-evidence").await;
    let id = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    for number in ["000-85-00050", "000-00-00086", "220-00-12349"] {
        let refusal = code(
            store
                .create_registration(&cmd(&actor), id, certificate(number))
                .await
                .unwrap_err(),
        );
        assert!(refusal.1.contains(&(
            "classification_reason".into(),
            "registration_classification_reason_required"
        )));
    }
    assert!(
        store
            .get_entity(&actor, id, true)
            .await
            .unwrap()
            .registrations
            .is_empty()
    );
    let mut branch = certificate("000-85-00050");
    branch.classification_reason = Some(Some(
        "본점 등록증을 요청했으며 지점 등록번호임을 확인했습니다".into(),
    ));
    let saved = store
        .create_registration(&cmd(&actor), id, branch)
        .await
        .unwrap();
    assert!(
        saved
            .record
            .current
            .unwrap()
            .classification_reason
            .is_some()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn identifier_corrections_cannot_turn_the_primary_into_a_branch(owner: PgPool) {
    use console_entity_domain::correction::IdentifierCorrectionInput;
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "classification-correction").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record;
    let reg = store
        .create_registration(&cmd(&actor), entity.id, certificate("000-81-00009"))
        .await
        .unwrap()
        .record;
    let doc = corrections_support::evidence(&store, &actor, "classification").await;
    for (field, value) in [("brn", "000-85-00050"), ("biz_kind", "INDIVIDUAL")] {
        let input = IdentifierCorrectionInput {
            field: Some(field.into()),
            value: Some(value.into()),
            document_id: Some(doc),
            reason_code: Some("REGISTRY_DIFFERS".into()),
            ..Default::default()
        };
        let err = if field == "brn" {
            store
                .correct_registration_number(&cmd(&actor), reg.id, input, None)
                .await
                .unwrap_err()
        } else {
            store
                .correct_entity_identifier(&cmd(&actor), entity.id, input, None)
                .await
                .unwrap_err()
        };
        assert!(code(err).1.contains(&(
            "classification_reason".into(),
            "registration_classification_reason_required"
        )));
    }
    let unchanged = store.get_entity(&actor, entity.id, true).await.unwrap();
    assert_eq!(
        unchanged.registrations[0].brn.as_ref().unwrap().value,
        reg.brn.as_ref().unwrap().value
    );
    assert!(
        corrections_support::ledger(&owner, entity.id)
            .await
            .is_empty()
    );
}
