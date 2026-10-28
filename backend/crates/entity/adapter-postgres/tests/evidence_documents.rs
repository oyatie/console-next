#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! ENT-CAPTURE kept originals as the runtime role `console_rt` (FORCE RLS):
//! upload, attach, supersede, read back, immutability and isolation.

mod common;

use common::*;
use console_entity_domain::document::{DocumentKind, validate_upload};
use sqlx::PgPool;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E07);
const ORG_B: Uuid = Uuid::from_u128(0xB000_0000_0000_0000_0000_0000_0000_0E07);

fn pdf(tag: &str) -> console_entity_domain::document::DocumentUpload {
    validate_upload(
        Some("BIZ_REG_CERT"),
        Some("사업자등록증.pdf"),
        format!("%PDF-1.7 {tag}").into_bytes(),
    )
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_certificate_is_kept_attached_and_superseded_by_the_next(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let first = store.upload_document(&actor, pdf("v1")).await.unwrap();
    assert_eq!(
        (first.kind, first.extraction_status, first.legal_entity_id),
        (DocumentKind::BizRegCert, "NONE", None)
    );
    // The same file again is the same document (a retried upload adds nothing).
    assert_eq!(
        store.upload_document(&actor, pdf("v1")).await.unwrap().id,
        first.id
    );

    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    store
        .attach_document(&actor, first.id, entity, None)
        .await
        .unwrap();
    let mut cert = certificate("000-81-00009");
    cert.cert_issued_on = Some("2024-05-02".into());
    let reg = store
        .create_registration(&cmd(&actor), entity, cert)
        .await
        .unwrap()
        .record
        .id;
    let attached = store
        .attach_document(&actor, first.id, entity, Some(reg))
        .await
        .unwrap();
    assert_eq!(attached.registration_id, Some(reg));
    assert_eq!(
        attached.issued_on.map(|d| d.to_string()).as_deref(),
        Some("2024-05-02")
    );
    // Attaching again changes nothing.
    assert_eq!(
        store
            .attach_document(&actor, first.id, entity, Some(reg))
            .await
            .unwrap()
            .superseded_at,
        None
    );

    // A 재발급 certificate supersedes the first; its retention clock starts.
    let second = store.upload_document(&actor, pdf("v2")).await.unwrap();
    store
        .attach_document(&actor, second.id, entity, Some(reg))
        .await
        .unwrap();
    let docs = store.list_documents(&actor, entity).await.unwrap();
    assert_eq!(docs.len(), 2);
    let old = docs.iter().find(|d| d.id == first.id).unwrap();
    let new = docs.iter().find(|d| d.id == second.id).unwrap();
    assert!(old.superseded_at.is_some() && new.superseded_at.is_none());
    assert!(old.clone().with_retention(Some(5)).retain_until.is_some());

    // Never moved to another 법인.
    let other = store
        .create_entity(&cmd(&actor), corporation("주식회사 다라", "000111-0000013"))
        .await
        .unwrap()
        .record
        .id;
    let (_, fields, _) = code(
        store
            .attach_document(&actor, first.id, other, None)
            .await
            .unwrap_err(),
    );
    assert_eq!(
        fields,
        vec![("document_id".to_owned(), "document_attached_elsewhere")]
    );
    let (_, fields, _) = code(
        store
            .attach_document(&actor, Uuid::new_v4(), entity, None)
            .await
            .unwrap_err(),
    );
    assert_eq!(
        fields,
        vec![("document_id".to_owned(), "document_not_found")]
    );

    // Reading the bytes back is audited; the bytes are what was uploaded.
    let access = console_kernel_core::AuditEvent::new(
        Some(actor.user),
        console_kernel_core::AuditAction::new("entity_document.read").unwrap(),
        "entity_document",
        first.id.to_string(),
        actor.trace.clone(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(actor.org);
    let content = store
        .document_content(&actor, first.id, access)
        .await
        .unwrap();
    assert_eq!(
        (content.bytes.as_slice(), content.content_type.as_str()),
        (b"%PDF-1.7 v1".as_slice(), "application/pdf")
    );
    let reads: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'entity_document.read'",
    )
    .bind(ORG_A)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(reads, 1);
    // No upload audit row carries the file name.
    let named: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND after_snap::text LIKE '%사업자등록증%'")
        .bind(ORG_A)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(named, 0);

    // The evidence is immutable and not deletable by the runtime role.
    let rt = store.pool();
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE entity_documents SET content = 'x' WHERE id = $1")
            .bind(first.id)
            .execute(&mut *tx)
            .await
            .is_err()
    );
    drop(tx);
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(
        sqlx::query("DELETE FROM entity_documents WHERE id = $1")
            .bind(first.id)
            .execute(&mut *tx)
            .await
            .is_err()
    );
    drop(tx);

    // Another tenant sees nothing.
    let (store_b, actor_b) = tenant(&owner, ORG_B, "B").await;
    let (code_b, _, _) = code(store_b.get_document(&actor_b, first.id).await.unwrap_err());
    assert_eq!(code_b, "document_not_found");
}
