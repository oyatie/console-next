#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 0h N-1 canary consistency: the previous release still reads a registration's
//! `trade_name`, so a 법인명 change appends a copy of each registration's head
//! carrying the new name in the same transaction. Nothing else changes, and the
//! copy is not a change a person sees in the registration's history.
mod common;
use common::*;
use console_entity_application::{LegalEntityRevision, LegalEntityView};
use sqlx::PgPool;
use uuid::Uuid;

fn revision(v: &LegalEntityView, name: &str, alias: &str) -> LegalEntityRevision {
    let state = v.current.as_ref().unwrap();
    let mut input = corporation(name, &v.crn.as_ref().unwrap().value);
    input.display_name = Some(alias.into());
    LegalEntityRevision {
        input,
        expected_version: Some(state.version),
        effective_from: Some(state.effective_from.to_string()),
        reason_code: Some("CORRECTION".into()),
    }
}

/// (version, trade_name, reason_code, business types) of the registration's head revision, as the N-1 binary reads it.
async fn head(owner: &PgPool, reg: Uuid) -> (i32, String, String, i64) {
    sqlx::query_as(
        "SELECT r.version, r.trade_name, r.reason_code, \
           (SELECT count(*) FROM business_registration_business_types t WHERE t.revision_id = r.id) \
         FROM business_registration_revisions r WHERE r.registration_id = $1 \
         ORDER BY r.effective_from DESC, r.version DESC LIMIT 1",
    )
    .bind(reg)
    .fetch_one(owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_legal_name_change_carries_the_new_name_to_every_registration_head(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "canary-name").await;
    let id = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000111-0012348"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), id, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    store
        .create_workplace(&cmd(&actor), id, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    let (version, trade, _, types) = head(&owner, reg).await;
    assert_eq!(trade, "주식회사 가나");
    let listed = store
        .registration_history(&actor, reg, true)
        .await
        .unwrap()
        .len();

    // An edit that keeps the 법인명 appends nothing to the registration.
    let view = store.get_entity(&actor, id, true).await.unwrap();
    store
        .revise_entity(&cmd(&actor), id, revision(&view, "주식회사 가나", "가나"))
        .await
        .unwrap();
    assert_eq!(head(&owner, reg).await.0, version);

    // A rename: the registration's head now says the new name, everything else copied.
    let view = store.get_entity(&actor, id, true).await.unwrap();
    store
        .revise_entity(&cmd(&actor), id, revision(&view, "주식회사 누리", "가나"))
        .await
        .unwrap();
    assert_eq!(
        head(&owner, reg).await,
        (
            version + 1,
            "주식회사 누리".into(),
            "LEGAL_NAME_DERIVED".into(),
            types
        )
    );
    let view = store.get_entity(&actor, id, true).await.unwrap();
    let current = view.registrations[0].current.as_ref().unwrap();
    assert_eq!(current.trade_name, "주식회사 누리");
    assert_eq!(
        store
            .registration_history(&actor, reg, true)
            .await
            .unwrap()
            .len(),
        listed,
        "the N-1 copy is not a change a person made"
    );

    // A 등록증 sheet opened before the rename still saves: no person changed the registration.
    let back = console_entity_application::RegistrationRevision {
        expected_version: Some(version),
        effective_from: Some(current.effective_from.to_string()),
        reason_code: Some("CORRECTION".into()),
        input: certificate("000-81-00009"),
    };
    let status = console_entity_application::RegistrationStatusInput {
        status: Some("CONTINUING".into()),
        ..Default::default()
    };
    store
        .revise_registration(&cmd(&actor), reg, back.clone(), status.clone())
        .await
        .unwrap();
    // Once a person has, the old read is stale.
    let stale = store
        .revise_registration(&cmd(&actor), reg, back, status)
        .await
        .unwrap_err();
    assert_eq!(code(stale).0, "stale_revision");
}
