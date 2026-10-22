// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use console_entity_application::{RegistrationRevision, RegistrationStatusInput};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn independent_individual_unrelated_edit_preserves_certificate_fact(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "independent-individual").await;
    let entity = store
        .create_entity(
            &cmd(&actor),
            console_entity_domain::legal_entity::LegalEntityInput {
                biz_kind: Some("INDIVIDUAL".into()),
                name: Some("본점 상호".into()),
                representation_mode: Some("SINGLE".into()),
                representatives: vec!["홍길동".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), entity, certificate("000-01-00007"))
        .await
        .unwrap()
        .record
        .id;
    let own_name = "다른 등록증 한글🏢e\u{301}";
    sqlx::query("INSERT INTO business_registration_revisions SELECT (jsonb_populate_record(NULL::business_registration_revisions, to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'version', r.version + 1, 'trade_name', $2::text, 'command_id', gen_random_uuid()))).* FROM business_registration_revisions r WHERE r.registration_id = $1 ORDER BY r.version DESC LIMIT 1")
        .bind(reg).bind(own_name).execute(&owner).await.unwrap();
    let (version, on): (i32, time::Date) = sqlx::query_as("SELECT version, effective_from FROM business_registration_revisions WHERE registration_id = $1 ORDER BY version DESC LIMIT 1").bind(reg).fetch_one(&owner).await.unwrap();
    let mut input = certificate("000-01-00007");
    input.tax_office_label = Some("다른 세무서".into());
    let revise = RegistrationRevision {
        expected_version: Some(version),
        effective_from: Some(on.to_string()),
        reason_code: Some("CORRECTION".into()),
        input,
    };
    let status = RegistrationStatusInput {
        status: Some("CONTINUING".into()),
        ..Default::default()
    };
    let (_, outsider) = tenant(&owner, Uuid::new_v4(), "independent-outsider").await;
    let error = store
        .revise_registration(&cmd(&outsider), reg, revise.clone(), status.clone())
        .await
        .unwrap_err();
    assert_eq!(code(error).0, "registration_not_found");
    let once = cmd(&actor);
    store
        .revise_registration(&once, reg, revise.clone(), status.clone())
        .await
        .unwrap();
    store
        .revise_registration(&once, reg, revise, status)
        .await
        .unwrap();
    let saved: Option<String> = sqlx::query_scalar("SELECT trade_name FROM business_registration_revisions WHERE registration_id = $1 ORDER BY version DESC LIMIT 1").bind(reg).fetch_one(&owner).await.unwrap();
    assert_eq!(
        saved.as_deref(),
        Some(own_name),
        "editing tax office must not overwrite the individual certificate's own name"
    );
}

#[path = "individual_trade_name/cases.rs"]
mod cases;
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, LegalEntityView};
use console_entity_domain::{legal_entity::LegalEntityInput, registration::RegistrationInput};

fn individual(name: &str) -> LegalEntityInput {
    LegalEntityInput {
        biz_kind: Some("INDIVIDUAL".into()),
        name: Some(name.into()),
        representation_mode: Some("SINGLE".into()),
        representatives: vec!["홍길동".into()],
        ..Default::default()
    }
}
fn printed(brn: &str, name: &str) -> RegistrationInput {
    let mut value = serde_json::to_value(certificate(brn)).unwrap();
    value["trade_name"] = name.into();
    serde_json::from_value(value).unwrap()
}
fn status() -> RegistrationStatusInput {
    RegistrationStatusInput {
        status: Some("CONTINUING".into()),
        ..Default::default()
    }
}
async fn head(pool: &PgPool, id: Uuid) -> (i32, Option<String>) {
    sqlx::query_as("SELECT version, trade_name FROM business_registration_revisions WHERE registration_id=$1 ORDER BY effective_from DESC, version DESC LIMIT 1")
        .bind(id).fetch_one(pool).await.unwrap()
}
fn revision(e: &LegalEntityView, id: Uuid, input: RegistrationInput) -> RegistrationRevision {
    let c = e
        .registrations
        .iter()
        .find(|r| r.id == id)
        .unwrap()
        .current
        .as_ref()
        .unwrap();
    RegistrationRevision {
        expected_version: Some(c.version),
        effective_from: Some(c.effective_from.to_string()),
        reason_code: Some("CORRECTION".into()),
        input,
    }
}
async fn individual_setup(pool: &PgPool) -> (PgEntityStore, Actor, Uuid, Uuid) {
    let (store, actor) = tenant(pool, Uuid::new_v4(), "individual").await;
    let id = store
        .create_entity(&cmd(&actor), individual("가나상회"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), id, printed("000-01-00007", "독립 상호"))
        .await
        .unwrap()
        .record
        .id;
    (store, actor, id, reg)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn individual_names_survive_rename_and_batch_undo(pool: PgPool) {
    use console_entity_application::{EntitySetupBatch, EntitySetupOp, LegalEntityRevision};
    let (store, actor, id, reg) = individual_setup(&pool).await;
    let view = store.get_entity(&actor, id, true).await.unwrap();
    let current = view.current.unwrap();
    store
        .revise_entity(
            &cmd(&actor),
            id,
            LegalEntityRevision {
                expected_version: Some(current.version),
                effective_from: Some(current.effective_from.to_string()),
                reason_code: Some("CORRECTION".into()),
                input: individual("새 본점 이름"),
            },
        )
        .await
        .unwrap();
    let view = store.get_entity(&actor, id, true).await.unwrap();
    assert_eq!(
        view.registrations[0].current.as_ref().unwrap().trade_name,
        "독립 상호"
    );
    let current = view.current.unwrap();
    let mut batch = EntitySetupBatch {
        dry_run: true,
        ops: vec![EntitySetupOp {
            op: Some("REVISE_ENTITY".into()),
            id: Some(id),
            expected_version: Some(current.version),
            effective_from: Some(current.effective_from.to_string()),
            reason_code: Some("CORRECTION".into()),
            entity: Some(individual("일괄 이름")),
            ..Default::default()
        }],
        ..Default::default()
    };
    let preview = store
        .entity_setup_batch(&cmd(&actor), batch.clone(), port())
        .await
        .unwrap();
    batch.dry_run = false;
    batch.preview_digest = Some(preview.preview_digest);
    let saved = store
        .entity_setup_batch(&cmd(&actor), batch, port())
        .await
        .unwrap();
    store
        .undo_entity_setup_batch(&cmd(&actor), saved.batch_id.unwrap(), port())
        .await
        .unwrap();
    assert_eq!(head(&pool, reg).await.1.as_deref(), Some("독립 상호"));
    assert_eq!(
        store
            .get_entity(&actor, id, true)
            .await
            .unwrap()
            .registrations[0]
            .current
            .as_ref()
            .unwrap()
            .trade_name,
        "독립 상호"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn individual_certificates_read_their_own_names_and_dated_history(pool: PgPool) {
    use console_entity_application::ReadOptions;
    let (store, actor) = tenant(&pool, Uuid::new_v4(), "individual-dated").await;
    let mut input = individual("가나상회");
    input.vat_unit_mode = Some("PER_WORKPLACE".into());
    let id = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), id, printed("000-01-00007", "독립 상호"))
        .await
        .unwrap()
        .record
        .id;
    let second = printed("000-01-00012", "가나상회 2호점");
    let second = store
        .create_registration(&cmd(&actor), id, second)
        .await
        .unwrap()
        .record
        .id;
    let view = store.get_entity(&actor, id, true).await.unwrap();
    for (id, name) in [(reg, "독립 상호"), (second, "가나상회 2호점")] {
        assert_eq!(
            view.registrations
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .current
                .as_ref()
                .unwrap()
                .trade_name,
            name
        );
    }
    let mut rev = revision(&view, second, printed("000-01-00012", "가나상회 역삼점"));
    rev.effective_from = Some("2021-04-01".into());
    rev.reason_code = Some("AMENDMENT".into());
    store
        .revise_registration(&cmd(&actor), second, rev, status())
        .await
        .unwrap();
    let dated = store
        .get_entity_at(
            &actor,
            id,
            true,
            ReadOptions {
                as_of: Some(time::macros::date!(2021 - 03 - 31)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        dated
            .registrations
            .iter()
            .find(|r| r.id == second)
            .unwrap()
            .current
            .as_ref()
            .unwrap()
            .trade_name,
        "가나상회 2호점"
    );
    let history = serde_json::to_value(
        store
            .registration_history(&actor, second, true)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(
        history
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["changes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["field"] == "trade_name"
                    && c["before"] == "가나상회 2호점"
                    && c["after"] == "가나상회 역삼점")),
        "{history}"
    );
    assert_eq!(
        head(&pool, second).await.1.as_deref(),
        Some("가나상회 역삼점")
    );
}
