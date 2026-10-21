#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 등록증 재발급·정정 as `console_rt`: a new certificate changing 대표자 and
//! 소재지 is one dated, evidenced change (the registration's and the 법인's
//! revisions, the certificate linked, the old one superseded); every guard
//! refuses with its code and writes nothing.

mod common;
mod reissue_support;

use common::*;
use reissue_support::*;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_new_certificate_changes_its_facts_as_one_evidenced_change(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "C").await;
    let (entity, reg, first) = setup(&store, &actor).await;
    let second = upload(&store, &actor, "v2").await;
    let once = cmd(&actor);
    let body = moved(&store, &actor, entity, reg, Some(second)).await;
    let saved = store
        .reissue_registration(&once, reg, body.clone())
        .await
        .unwrap();
    assert_eq!(saved.change_mode, "SETUP");
    // The 법인's VAT unit was recorded today, after 10-01: its 대표자 change starts there, and the save says so.
    assert!(
        saved
            .warnings
            .iter()
            .any(|w| w.code == "entity_change_from_later_state"),
        "{:?}",
        saved.warnings
    );
    let c = saved.record.current.as_ref().unwrap();
    assert_eq!(c.business_address.as_ref().unwrap().road_addr_part1, BUSAN);
    assert_eq!(c.cert_issued_on.unwrap().to_string(), "2026-10-02");
    // Every surface derives from the one record: the 법인's 대표자 is the certificate's.
    let e = store.get_entity(&actor, entity, true).await.unwrap();
    assert_eq!(
        e.current.as_ref().unwrap().representatives.as_deref(),
        Some(&["김대표".to_owned()][..])
    );

    // The new certificate is in force, the old one kept as superseded evidence.
    let docs = store.list_documents(&actor, entity).await.unwrap();
    let new = docs.iter().find(|d| d.id == second).unwrap();
    let old = docs.iter().find(|d| d.id == first).unwrap();
    assert_eq!(
        (new.registration_id, new.superseded_at.is_none()),
        (Some(reg), true)
    );
    assert_eq!(new.issued_on.unwrap().to_string(), "2026-10-02");
    assert!(
        old.superseded_at.is_some(),
        "the earlier certificate stays, superseded"
    );

    // History: the revision names its certificate and what changed.
    let history = store.registration_history(&actor, reg, true).await.unwrap();
    let top = &history[0];
    assert_eq!(
        (top.reason_code.as_deref(), top.evidence_document_id),
        (Some("CERT_CHANGE_REPORT"), Some(second))
    );
    assert_eq!(top.effective_from.to_string(), "2026-10-01");
    assert!(
        top.changes.iter().any(|f| f.field == "business_address"),
        "{:?}",
        top.changes
    );
    assert!(
        top.changes
            .iter()
            .all(|f| f.field != "evidence_document_id"),
        "provenance is not a changed fact"
    );
    assert_eq!(
        history
            .iter()
            .filter(|h| h.evidence_document_id.is_some())
            .count(),
        1
    );

    // The same intent again replays: nothing more is recorded.
    let again = store.reissue_registration(&once, reg, body).await.unwrap();
    assert_eq!(again.record.current.unwrap().version, c.version);
    assert_eq!(
        store
            .registration_history(&actor, reg, true)
            .await
            .unwrap()
            .len(),
        history.len()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_guard_refuses_with_its_code_and_writes_nothing(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "C").await;
    let (entity, reg, _) = setup(&store, &actor).await;
    let before = versions(&store, &actor, entity, reg).await;
    let second = upload(&store, &actor, "v2").await;

    let no_doc = moved(&store, &actor, entity, reg, None).await;
    assert_eq!(
        codes(
            store
                .reissue_registration(&cmd(&actor), reg, no_doc)
                .await
                .unwrap_err()
        ),
        ["required"]
    );

    let mut bare = moved(&store, &actor, entity, reg, Some(second)).await;
    bare.reason = Some("CHANGE".into());
    bare.effective_from = Some("2999-01-01".into());
    bare.registration.input.cert_issued_on = None;
    assert_eq!(
        codes(
            store
                .reissue_registration(&cmd(&actor), reg, bare)
                .await
                .unwrap_err()
        ),
        ["invalid_option", "date_in_future", "required"]
    );

    let extract = store
        .upload_document(&actor, file("CORP_REGISTRY_EXTRACT", "x"))
        .await
        .unwrap()
        .id;
    let wrong_kind = moved(&store, &actor, entity, reg, Some(extract)).await;
    assert_eq!(
        codes(
            store
                .reissue_registration(&cmd(&actor), reg, wrong_kind)
                .await
                .unwrap_err()
        ),
        ["document_not_certificate"]
    );

    let other = store
        .create_entity(&cmd(&actor), corporation("주식회사 다라", "000111-0012348"))
        .await
        .unwrap()
        .record
        .id;
    let theirs = upload(&store, &actor, "theirs").await;
    store
        .attach_document(&actor, theirs, other, None)
        .await
        .unwrap();
    let elsewhere = moved(&store, &actor, entity, reg, Some(theirs)).await;
    assert_eq!(
        codes(
            store
                .reissue_registration(&cmd(&actor), reg, elsewhere)
                .await
                .unwrap_err()
        ),
        ["document_attached_elsewhere"]
    );

    let mut stale = moved(&store, &actor, entity, reg, Some(second)).await;
    stale.registration.expected_version = Some(before.1 + 3);
    assert_eq!(
        codes(
            store
                .reissue_registration(&cmd(&actor), reg, stale)
                .await
                .unwrap_err()
        ),
        ["stale_revision"]
    );
    let mut stale_entity = moved(&store, &actor, entity, reg, Some(second)).await;
    stale_entity.entity.as_mut().unwrap().expected_version = Some(before.0 + 5);
    assert_eq!(
        codes(
            store
                .reissue_registration(&cmd(&actor), reg, stale_entity)
                .await
                .unwrap_err()
        ),
        ["stale_revision"]
    );

    let (other_store, other_actor) = tenant(&owner, ORG_B, "D").await;
    let foreign = moved(&store, &actor, entity, reg, Some(second)).await;
    assert_eq!(
        codes(
            other_store
                .reissue_registration(&cmd(&other_actor), reg, foreign)
                .await
                .unwrap_err()
        ),
        ["registration_not_found"]
    );

    // Nothing was written by any refusal: versions, the 대표자 and the documents as before.
    assert_eq!(versions(&store, &actor, entity, reg).await, before);
    let docs = store.list_documents(&actor, entity).await.unwrap();
    assert!(
        docs.iter()
            .all(|d| d.id != second && d.superseded_at.is_none()),
        "{docs:?}"
    );
}
