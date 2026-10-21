#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Shared by the ENT-REG correction tests: evidence, the correction body,
//! the ledger as stored.

use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::Actor;
use console_entity_domain::correction::IdentifierCorrectionInput;
use console_entity_domain::document::validate_upload;
use sqlx::PgPool;
use uuid::Uuid;

pub const CRN: &str = "000211-0006241";
pub const FIXED_CRN: &str = "0002110000011";

pub async fn evidence(store: &PgEntityStore, actor: &Actor, tag: &str) -> Uuid {
    let upload = validate_upload(
        Some("CORP_REGISTRY_EXTRACT"),
        Some("등기사항전부증명서.pdf"),
        format!("%PDF-1.7 {tag}").into_bytes(),
    )
    .unwrap();
    store.upload_document(actor, upload).await.unwrap().id
}

pub fn crn_fix(document: Uuid, exception: Option<Uuid>) -> IdentifierCorrectionInput {
    IdentifierCorrectionInput {
        field: Some("crn".into()),
        value: Some(FIXED_CRN.into()),
        document_id: Some(document),
        reason_code: Some("REGISTRY_DIFFERS".into()),
        exception_id: exception,
        ..IdentifierCorrectionInput::default()
    }
}

pub async fn ledger(
    owner: &PgPool,
    entity: Uuid,
) -> Vec<(String, Option<String>, Option<String>, String)> {
    sqlx::query_as(
        "SELECT field, old_value, new_value, change_mode FROM entity_identifier_corrections \
         WHERE legal_entity_id = $1 ORDER BY created_at, field",
    )
    .bind(entity)
    .fetch_all(owner)
    .await
    .unwrap()
}
