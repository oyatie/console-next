#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! ENT-REG as the runtime role `console_rt`: 임원 read back and kept (MR-5),
//! and identifier corrections with evidence in SETUP (MR-17).

mod common;
mod corrections_support;

use common::*;
use console_entity_application::LegalEntityRevision;
use console_entity_domain::correction::IdentifierCorrectionInput;
use console_entity_domain::legal_entity::DirectorInput;
use corrections_support::*;
use sqlx::PgPool;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E17);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn directors_are_read_back_kept_when_omitted_and_cleared_on_empty(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let mut input = corporation("주식회사 가나", CRN);
    input.directors = Some(vec![
        DirectorInput {
            role: Some("INSIDE_DIRECTOR".into()),
            name: Some("김이사".into()),
            appointed_on: Some("2024-03-01".into()),
        },
        DirectorInput {
            role: Some("AUDITOR".into()),
            name: Some("박감사".into()),
            appointed_on: None,
        },
    ]);
    let created = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record;
    let current = created.current.as_ref().unwrap();
    let directors = current.directors.as_ref().unwrap();
    assert_eq!((directors.len(), directors[0].name.as_str()), (2, "김이사"));
    assert_eq!(
        directors[1].appointed_on, None,
        "an undated 임원 reads back"
    );
    let public = store.get_entity(&actor, created.id, false).await.unwrap();
    assert!(
        public.current.unwrap().directors.is_none(),
        "restricted like 대표자"
    );

    // A form that never shows 임원 (directors omitted) keeps them.
    let revise = |version, from: &str, directors| LegalEntityRevision {
        expected_version: Some(version),
        effective_from: Some(from.into()),
        reason_code: Some("CAPITAL".into()),
        input: {
            let mut i = corporation("주식회사 가나", CRN);
            i.directors = directors;
            i
        },
    };
    let kept = store
        .revise_entity(
            &cmd(&actor),
            created.id,
            revise(current.version, "2030-01-01", None),
        )
        .await
        .unwrap()
        .record;
    assert_eq!(kept.scheduled[0].directors.as_ref().unwrap().len(), 2);
    let cleared = store
        .revise_entity(
            &cmd(&actor),
            created.id,
            revise(current.version + 1, "2031-01-01", Some(vec![])),
        )
        .await
        .unwrap()
        .record;
    assert!(cleared.scheduled[1].directors.as_ref().unwrap().is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_correction_needs_evidence_writes_the_ledger_and_revise_refuses(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let created = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", CRN))
        .await
        .unwrap()
        .record;
    // A plain revise no longer changes a set identifier.
    let rev = LegalEntityRevision {
        expected_version: Some(created.current.as_ref().unwrap().version),
        effective_from: Some("2030-01-01".into()),
        reason_code: Some("FIX".into()),
        input: corporation("주식회사 가나", "000111-0012348"),
    };
    let (_, fields, remedy) = code(
        store
            .revise_entity(&cmd(&actor), created.id, rev)
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (fields, remedy),
        (
            vec![("crn".into(), "use_identifier_correction")],
            Some("request_identifier_correction")
        )
    );

    let doc = evidence(&store, &actor, "crn").await;
    let saved = store
        .correct_entity_identifier(&cmd(&actor), created.id, crn_fix(doc, None), None)
        .await
        .unwrap();
    let console_entity_adapter_postgres::CorrectionOutcome::Applied(saved) = saved else {
        panic!("expected applied correction")
    };
    assert_eq!(
        (saved.change_mode.as_str(), saved.record.crn.unwrap().value),
        ("SETUP", FIXED_CRN.to_owned())
    );
    assert_eq!(
        ledger(&owner, created.id).await,
        vec![(
            "crn".into(),
            Some("0002110006241".into()),
            Some(FIXED_CRN.into()),
            "SETUP".into()
        )]
    );
    let history = store
        .entity_history(&actor, created.id, false)
        .await
        .unwrap();
    let crn = history[0]
        .changes
        .iter()
        .find(|c| c.field == "crn")
        .unwrap();
    assert_eq!(
        (
            crn.before.as_deref(),
            crn.after.as_deref(),
            history[0].reason_code.as_deref()
        ),
        (
            Some("0002110006241"),
            Some(FIXED_CRN),
            Some("REGISTRY_DIFFERS")
        )
    );
    let attached = store.get_document(&actor, doc).await.unwrap();
    assert_eq!(
        attached.legal_entity_id,
        Some(created.id),
        "the evidence is kept on the 법인"
    );
    let (_, fields, _) = code(
        store
            .correct_entity_identifier(&cmd(&actor), created.id, crn_fix(doc, None), None)
            .await
            .unwrap_err(),
    );
    assert_eq!(fields, vec![("value".into(), "identifier_unchanged")]);

    // Leaving CORPORATION clears the 법인등록번호 in the same command.
    let kind = IdentifierCorrectionInput {
        field: Some("biz_kind".into()),
        value: Some("INDIVIDUAL".into()),
        ..crn_fix(doc, None)
    };
    let saved = store
        .correct_entity_identifier(&cmd(&actor), created.id, kind, None)
        .await
        .unwrap();
    let console_entity_adapter_postgres::CorrectionOutcome::Applied(saved) = saved else {
        panic!("expected applied correction")
    };
    assert!(saved.record.crn.is_none());
    assert_eq!(ledger(&owner, created.id).await.len(), 3);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn brn_correction_keeps_the_certificate_and_drops_the_old_check(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", CRN))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    // As if it had been checked against the old number.
    sqlx::query("UPDATE business_registrations SET verification_tier = 'T1', unverified_reason = NULL WHERE id = $1")
        .bind(reg)
        .execute(&owner)
        .await
        .unwrap();
    let upload = console_entity_domain::document::validate_upload(
        Some("BIZ_REG_CERT"),
        Some("사업자등록증.pdf"),
        b"%PDF-1.7 brn".to_vec(),
    )
    .unwrap();
    let doc = store.upload_document(&actor, upload).await.unwrap().id;
    let fix = IdentifierCorrectionInput {
        field: Some("brn".into()),
        value: Some("000-81-00071".into()),
        ..crn_fix(doc, None)
    };
    let saved = store
        .correct_registration_number(&cmd(&actor), reg, fix, None)
        .await
        .unwrap();
    let console_entity_adapter_postgres::CorrectionOutcome::Applied(saved) = saved else {
        panic!("expected applied correction")
    };
    let saved = saved.record;
    assert_eq!(
        (
            saved.brn.unwrap().value.as_str(),
            saved.verification_tier.as_str()
        ),
        ("0008100071", "NONE")
    );
    let ledger: (Option<uuid::Uuid>, String) = sqlx::query_as(
        "SELECT registration_id, new_value FROM entity_identifier_corrections WHERE field = 'brn'",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(ledger, (Some(reg), "0008100071".into()));
    assert_eq!(
        store
            .get_document(&actor, doc)
            .await
            .unwrap()
            .registration_id,
        Some(reg)
    );
    let history = store
        .registration_history(&actor, reg, false)
        .await
        .unwrap();
    assert!(
        history[0]
            .changes
            .iter()
            .any(|c| c.field == "brn" && c.after.as_deref() == Some("0008100071"))
    );
}
