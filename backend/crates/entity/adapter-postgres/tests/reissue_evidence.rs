#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The certificate a registration revision names: linked from the first one
//! (typed at creation) to each reissue, and refused unless it is a new,
//! kept 사업자등록증 — on the create, the reissue and the plain revise alike,
//! each refusal writing nothing.

mod common;
mod reissue_support;

use common::*;
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, RegistrationRevision, RegistrationStatusInput};
use reissue_support::*;
use sqlx::PgPool;
use uuid::Uuid;

/// A 법인 whose certificate is recorded with its original, as the create sheet does.
async fn evidenced(store: &PgEntityStore, actor: &Actor) -> (Uuid, Uuid, Uuid) {
    let entity = store
        .create_entity(&cmd(actor), corporation("주식회사 가나", CRN))
        .await
        .unwrap()
        .record
        .id;
    let first = upload(store, actor, "v1").await;
    let mut cert = certificate(BRN);
    cert.cert_issued_on = Some("2020-03-02".into());
    let reg = store
        .create_registration_evidenced(&cmd(actor), entity, cert, Some(first))
        .await
        .unwrap()
        .record
        .id;
    (entity, reg, first)
}

async fn revise(
    store: &PgEntityStore,
    actor: &Actor,
    entity: Uuid,
    reg: Uuid,
    doc: Uuid,
) -> Vec<&'static str> {
    let (_, rv) = versions(store, actor, entity, reg).await;
    let rev = RegistrationRevision {
        expected_version: Some(rv),
        effective_from: Some("2026-10-01".into()),
        reason_code: Some("CORRECTION".into()),
        input: certificate(BRN),
    };
    let status = RegistrationStatusInput {
        status: Some("CONTINUING".into()),
        ..RegistrationStatusInput::default()
    };
    codes(
        store
            .revise_registration_evidenced(&cmd(actor), reg, rev, status, Some(doc))
            .await
            .unwrap_err(),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_history_names_every_issued_certificate(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "C").await;
    let (entity, reg, first) = evidenced(&store, &actor).await;
    let docs = store.list_documents(&actor, entity).await.unwrap();
    let kept = docs.iter().find(|d| d.id == first).unwrap();
    assert_eq!(
        (kept.registration_id, kept.issued_on.unwrap().to_string()),
        (Some(reg), "2020-03-02".into())
    );

    let second = upload(&store, &actor, "v2").await;
    let body = moved(&store, &actor, entity, reg, Some(second)).await;
    store
        .reissue_registration(&cmd(&actor), reg, body)
        .await
        .unwrap();
    let history = store.registration_history(&actor, reg, true).await.unwrap();
    let named: Vec<_> = history
        .iter()
        .filter_map(|h| h.evidence_document_id)
        .collect();
    assert_eq!(
        named,
        [second, first],
        "newest first, each certificate where it was recorded"
    );
    assert_eq!(
        history.last().unwrap().reason_code.as_deref(),
        Some("CREATE")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_a_new_certificate_is_accepted_on_every_path(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "C").await;
    let (entity, reg, first) = evidenced(&store, &actor).await;
    let unknown = Uuid::from_u128(0xDEAD);
    let extract = store
        .upload_document(&actor, file("CORP_REGISTRY_EXTRACT", "x"))
        .await
        .unwrap()
        .id;
    let before = versions(&store, &actor, entity, reg).await;

    // The reissue: an unknown document, and the certificate in force.
    for (doc, code) in [(unknown, "document_not_found"), (first, "document_not_new")] {
        let body = moved(&store, &actor, entity, reg, Some(doc)).await;
        assert_eq!(
            codes(
                store
                    .reissue_registration(&cmd(&actor), reg, body)
                    .await
                    .unwrap_err()
            ),
            [code]
        );
    }
    // The plain revise with a document: the same guards, and a registry extract is no certificate.
    assert_eq!(
        revise(&store, &actor, entity, reg, unknown).await,
        ["document_not_found"]
    );
    assert_eq!(
        revise(&store, &actor, entity, reg, extract).await,
        ["document_not_certificate"]
    );
    assert_eq!(
        revise(&store, &actor, entity, reg, first).await,
        ["document_not_new"]
    );
    assert_eq!(
        versions(&store, &actor, entity, reg).await,
        before,
        "no refusal wrote a revision"
    );

    // Once replaced, neither the superseded certificate nor the one now in force is new.
    let second = upload(&store, &actor, "v2").await;
    let body = moved(&store, &actor, entity, reg, Some(second)).await;
    store
        .reissue_registration(&cmd(&actor), reg, body)
        .await
        .unwrap();
    let after = versions(&store, &actor, entity, reg).await;
    for doc in [first, second] {
        let body = moved(&store, &actor, entity, reg, Some(doc)).await;
        assert_eq!(
            codes(
                store
                    .reissue_registration(&cmd(&actor), reg, body)
                    .await
                    .unwrap_err()
            ),
            ["document_not_new"]
        );
    }
    // The same file dropped again is the same (superseded) document.
    let again = upload(&store, &actor, "v1").await;
    assert_eq!(again, first);
    assert_eq!(versions(&store, &actor, entity, reg).await, after);
    let docs = store.list_documents(&actor, entity).await.unwrap();
    let in_force: Vec<_> = docs
        .iter()
        .filter(|d| d.registration_id == Some(reg) && d.superseded_at.is_none())
        .map(|d| d.id)
        .collect();
    assert_eq!(in_force, [second]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_create_with_a_wrong_document_records_nothing(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "C").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", CRN))
        .await
        .unwrap()
        .record
        .id;
    let extract = store
        .upload_document(&actor, file("CORP_REGISTRY_EXTRACT", "x"))
        .await
        .unwrap()
        .id;
    for (doc, code) in [
        (Uuid::from_u128(0xDEAD), "document_not_found"),
        (extract, "document_not_certificate"),
    ] {
        let err = store
            .create_registration_evidenced(&cmd(&actor), entity, certificate(BRN), Some(doc))
            .await
            .unwrap_err();
        assert_eq!(codes(err), [code]);
    }
    let e = store.get_entity(&actor, entity, true).await.unwrap();
    assert!(e.registrations.is_empty(), "{:?}", e.registrations);
}
