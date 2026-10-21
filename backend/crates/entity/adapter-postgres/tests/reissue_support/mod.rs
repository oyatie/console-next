#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Shared by the 등록증 재발급·정정 tests: a 법인 with one certificate and
//! its original, the 정정 신고 that moves it to 부산 with a new 대표자, and
//! the refusal codes a call answered with.

use crate::common::*;
use console_entity_adapter_postgres::{PgEntityError, PgEntityStore};
use console_entity_application::{
    Actor, RegistrationReissue, RegistrationStatusInput, ReissuedEntity, ReissuedRegistration,
};
use console_entity_domain::document::{DocumentUpload, validate_upload};
use uuid::Uuid;

pub const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0C2E);
pub const ORG_B: Uuid = Uuid::from_u128(0xB000_0000_0000_0000_0000_0000_0000_0C2E);
pub const CRN: &str = "000211-0006241";
pub const BRN: &str = "000-81-62515";
pub const BUSAN: &str = "부산광역시 해운대구 센텀중앙로 79";

pub fn file(kind: &str, tag: &str) -> DocumentUpload {
    validate_upload(
        Some(kind),
        Some("사업자등록증.pdf"),
        format!("%PDF-1.7 {tag}").into_bytes(),
    )
    .unwrap()
}

pub async fn upload(store: &PgEntityStore, actor: &Actor, tag: &str) -> Uuid {
    store
        .upload_document(actor, file("BIZ_REG_CERT", tag))
        .await
        .unwrap()
        .id
}

/// A 법인 with one certificate and its first original attached.
pub async fn setup(store: &PgEntityStore, actor: &Actor) -> (Uuid, Uuid, Uuid) {
    let entity = store
        .create_entity(&cmd(actor), corporation("주식회사 가나", CRN))
        .await
        .unwrap()
        .record
        .id;
    let mut cert = certificate(BRN);
    cert.cert_issued_on = Some("2020-03-02".into());
    let reg = store
        .create_registration(&cmd(actor), entity, cert)
        .await
        .unwrap()
        .record
        .id;
    let first = upload(store, actor, "v1").await;
    store
        .attach_document(actor, first, entity, Some(reg))
        .await
        .unwrap();
    (entity, reg, first)
}

pub async fn versions(store: &PgEntityStore, actor: &Actor, entity: Uuid, reg: Uuid) -> (i32, i32) {
    let e = store.get_entity(actor, entity, true).await.unwrap();
    let r = e.registrations.iter().find(|r| r.id == reg).unwrap();
    (
        e.current.unwrap().version,
        r.current.as_ref().unwrap().version,
    )
}

/// 정정 신고 from 10-01: the certificate moved to 부산, and 대표자 is now 김대표.
pub async fn moved(
    store: &PgEntityStore,
    actor: &Actor,
    entity: Uuid,
    reg: Uuid,
    doc: Option<Uuid>,
) -> RegistrationReissue {
    let (ev, rv) = versions(store, actor, entity, reg).await;
    let mut input = certificate(BRN);
    input.business_address = Some(address(BUSAN));
    input.issue_reason_kind = Some("CORRECTION".into());
    input.issue_reason_sub = Some("RELOCATION".into());
    input.cert_issued_on = Some("2026-10-02".into());
    let mut e = corporation("주식회사 가나", CRN);
    e.representatives = vec!["김대표".into()];
    RegistrationReissue {
        document_id: doc,
        reason: Some("CERT_CHANGE_REPORT".into()),
        effective_from: Some("2026-10-01".into()),
        registration: ReissuedRegistration {
            expected_version: Some(rv),
            input,
            status: RegistrationStatusInput {
                status: Some("CONTINUING".into()),
                ..RegistrationStatusInput::default()
            },
        },
        entity: Some(ReissuedEntity {
            expected_version: Some(ev),
            input: e,
        }),
    }
}

pub fn codes(e: PgEntityError) -> Vec<&'static str> {
    match e {
        PgEntityError::Refused(r) if r.fields.is_empty() => vec![r.code],
        PgEntityError::Refused(r) => r.fields.iter().map(|f| f.code).collect(),
        other => panic!("not a refusal: {other}"),
    }
}
