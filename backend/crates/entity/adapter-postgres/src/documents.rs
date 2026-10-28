//! Kept originals (`entity_documents`): upload, attach to the record they
//! back, list, and read the bytes back (audited, restricted callers only).

use console_entity_application::{Actor, EntityDocumentView};
use console_entity_domain::Refusal;
use console_entity_domain::document::{DocumentKind, DocumentUpload};
use console_kernel_core::{AuditAction, AuditEvent};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::Row;
use sqlx::postgres::PgRow;
use uuid::Uuid;

use crate::{PgEntityError, PgEntityStore, Tx};

const RETENTION_KEY: &str = "retention.entity_registration_document";
/// The record's columns (never `content`): a macro so every query stays a
/// `&'static str` literal.
macro_rules! columns {
    () => {
        "id, kind, file_name, content_type, byte_size, uploaded_at, legal_entity_id, registration_id, issued_on, \
         superseded_at, retention_key"
    };
}

/// The bytes of a kept original, for the content route.
#[derive(Debug, Clone)]
pub struct DocumentContent {
    pub file_name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

fn view(r: &PgRow) -> Result<EntityDocumentView, PgEntityError> {
    let kind: String = r.try_get("kind")?;
    Ok(EntityDocumentView {
        id: r.try_get("id")?,
        kind: DocumentKind::parse(&kind).ok_or_else(|| Refusal::not_found("document_not_found"))?,
        file_name: r.try_get("file_name")?,
        content_type: r.try_get("content_type")?,
        byte_size: r.try_get("byte_size")?,
        uploaded_at: r.try_get("uploaded_at")?,
        legal_entity_id: r.try_get("legal_entity_id")?,
        registration_id: r.try_get("registration_id")?,
        issued_on: r.try_get("issued_on")?,
        superseded_at: r.try_get("superseded_at")?,
        retention_key: r.try_get("retention_key")?,
        retain_until: None,
        extraction_status: "NONE",
        extracted: None,
        preview_url: None,
    })
}

fn event(
    actor: &Actor,
    action: &str,
    id: Uuid,
    after: serde_json::Value,
) -> Result<AuditEvent, PgEntityError> {
    Ok(AuditEvent::new(
        Some(actor.user),
        AuditAction::new(action).map_err(Refusal::from)?,
        "entity_document",
        id.to_string(),
        actor.trace.clone(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(actor.org)
    .with_snapshots(None, Some(after)))
}

pub(crate) async fn one(
    tx: &mut Tx<'_>,
    id: Uuid,
    lock: bool,
) -> Result<EntityDocumentView, PgEntityError> {
    let sql = if lock {
        concat!(
            "SELECT ",
            columns!(),
            " FROM entity_documents WHERE id = $1 FOR UPDATE"
        )
    } else {
        concat!(
            "SELECT ",
            columns!(),
            " FROM entity_documents WHERE id = $1"
        )
    };
    let row = sqlx::query(sql)
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| Refusal::not_found("document_not_found"))?;
    view(&row)
}

impl PgEntityStore {
    /// Keep an uploaded original. The same file (bytes and kind) uploaded
    /// again is the same document: the first row is returned, nothing is
    /// added, so a retried upload is harmless without an Idempotency-Key.
    ///
    /// # Errors
    /// Database faults.
    pub async fn upload_document(
        &self,
        actor: &Actor,
        doc: DocumentUpload,
    ) -> Result<EntityDocumentView, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let inserted = sqlx::query(concat!(
                    "INSERT INTO entity_documents (org_id, kind, file_name, content_type, byte_size, sha256, content, \
                       retention_key, uploaded_by) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, sha256($5), $5, $6, $7) \
                     ON CONFLICT (org_id, sha256, kind) DO NOTHING RETURNING ",
                    columns!()
                ))
                .bind(doc.kind.as_str())
                .bind(&doc.file_name)
                .bind(doc.content_type)
                .bind(i32::try_from(doc.bytes.len()).map_err(|_| Refusal::field("file", "file_too_large"))?)
                .bind(&doc.bytes)
                .bind(RETENTION_KEY)
                .bind(*actor.user.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
                if let Some(row) = inserted {
                    let saved = view(&row)?;
                    // Never the file name in the audit trail: it may carry a name.
                    let audit = event(&actor, "entity_document.upload", saved.id,
                        json!({ "kind": saved.kind.as_str(), "byte_size": saved.byte_size, "content_type": saved.content_type }))?;
                    return Ok((saved, vec![audit]));
                }
                let row = sqlx::query(concat!(
                    "SELECT ",
                    columns!(),
                    " FROM entity_documents WHERE sha256 = sha256($1) AND kind = $2"
                ))
                .bind(&doc.bytes)
                .bind(doc.kind.as_str())
                .fetch_one(tx.as_mut())
                .await?;
                Ok((view(&row)?, vec![]))
            })
        })
        .await
    }

    /// Attach a kept document to the 법인 (and, for a certificate, the
    /// 사업자등록) it backs. A newer document of the same kind on the same
    /// record supersedes the older one (its retention clock starts). Attaching
    /// it again to the same record changes nothing.
    ///
    /// # Errors
    /// `document_id` field refusals (`document_not_found`,
    /// `document_attached_elsewhere`), a registration of another entity, or
    /// database faults.
    pub async fn attach_document(
        &self,
        actor: &Actor,
        id: Uuid,
        entity: Uuid,
        registration: Option<Uuid>,
    ) -> Result<EntityDocumentView, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let (doc, event) = attach_in_tx(tx, &actor, id, entity, registration).await?;
                Ok((doc, event.into_iter().collect()))
            })
        })
        .await
    }

    /// One document's record (no bytes).
    ///
    /// # Errors
    /// `document_not_found`, or database faults.
    pub async fn get_document(
        &self,
        actor: &Actor,
        id: Uuid,
    ) -> Result<EntityDocumentView, PgEntityError> {
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move { one(tx, id, false).await })
        })
        .await
    }

    /// The documents attached to a 법인, newest first (superseded ones too).
    ///
    /// # Errors
    /// `legal_entity_not_found`, or database faults.
    pub async fn list_documents(
        &self,
        actor: &Actor,
        entity: Uuid,
    ) -> Result<Vec<EntityDocumentView>, PgEntityError> {
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM legal_entities WHERE id = $1 AND voided_at IS NULL)")
                    .bind(entity)
                    .fetch_one(tx.as_mut())
                    .await?;
                if !exists {
                    return Err(Refusal::not_found("legal_entity_not_found").into());
                }
                let rows = sqlx::query(concat!(
                    "SELECT ",
                    columns!(),
                    " FROM entity_documents WHERE legal_entity_id = $1 ORDER BY uploaded_at DESC, id"
                ))
                .bind(entity)
                .fetch_all(tx.as_mut())
                .await?;
                rows.iter().map(view).collect()
            })
        })
        .await
    }

    /// The kept bytes. Every read is an audit row (접속기록: the original
    /// holds a representative's name and, for 개인사업자, a birth date).
    ///
    /// # Errors
    /// `document_not_found`, or database faults.
    pub async fn document_content(
        &self,
        actor: &Actor,
        id: Uuid,
        mut access: AuditEvent,
    ) -> Result<DocumentContent, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query("SELECT file_name, content_type, content, kind FROM entity_documents WHERE id = $1")
                    .bind(id)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| Refusal::not_found("document_not_found"))?;
                access.after.get_or_insert_with(|| json!({}))["kind"] = json!(row.try_get::<String, _>("kind")?);
                let content = DocumentContent {
                    file_name: row.try_get("file_name")?,
                    content_type: row.try_get("content_type")?,
                    bytes: row.try_get("content")?,
                };
                Ok((content, vec![access]))
            })
        })
        .await
    }
}

/// Attach evidence inside the caller's transaction (MR-17: a correction and
/// its evidence commit together). `None`: already attached to this record.
pub(crate) async fn attach_in_tx(
    tx: &mut Tx<'_>,
    actor: &Actor,
    id: Uuid,
    entity: Uuid,
    registration: Option<Uuid>,
) -> Result<(EntityDocumentView, Option<AuditEvent>), PgEntityError> {
    let doc = match one(tx, id, true).await {
        Err(PgEntityError::Refused(r)) if r.code == "document_not_found" => {
            return Err(Refusal::field("document_id", "document_not_found").into());
        }
        other => other?,
    };
    // Only a certificate backs a 사업자등록; other kinds stay on the 법인.
    let registration = registration.filter(|_| doc.kind == DocumentKind::BizRegCert);
    let issued_on: Option<time::Date> = match registration {
        None => None,
        Some(reg) => sqlx::query(
            "SELECT h.legal_entity_id, (SELECT cert_issued_on FROM business_registration_revisions x \
               WHERE x.registration_id = h.id ORDER BY x.version DESC LIMIT 1) AS issued_on \
             FROM business_registrations h WHERE h.id = $1",
        )
        .bind(reg)
        .fetch_optional(tx.as_mut())
        .await?
        .filter(|r| r.try_get::<Uuid, _>("legal_entity_id").ok() == Some(entity))
        .ok_or_else(|| Refusal::field("registration_id", "registration_of_other_entity"))?
        .try_get("issued_on")?,
    };
    if doc.attached_elsewhere(entity, registration) {
        return Err(Refusal::field("document_id", "document_attached_elsewhere").into());
    }
    if doc.legal_entity_id == Some(entity) && doc.registration_id == registration {
        return Ok((doc, None));
    }
    sqlx::query(
        "UPDATE entity_documents SET superseded_at = now() \
         WHERE id <> $1 AND kind = $2 AND superseded_at IS NULL AND legal_entity_id = $3 \
           AND registration_id IS NOT DISTINCT FROM $4",
    )
    .bind(id)
    .bind(doc.kind.as_str())
    .bind(entity)
    .bind(registration)
    .execute(tx.as_mut())
    .await?;
    let row = sqlx::query(concat!(
        "UPDATE entity_documents SET legal_entity_id = $2, registration_id = $3, \
           issued_on = COALESCE($4, issued_on) WHERE id = $1 RETURNING ",
        columns!()
    ))
    .bind(id)
    .bind(entity)
    .bind(registration)
    .bind(issued_on)
    .fetch_one(tx.as_mut())
    .await?;
    let audit = event(
        actor,
        "entity_document.attach",
        id,
        json!({ "legal_entity_id": entity, "registration_id": registration, "kind": doc.kind.as_str() }),
    )?;
    Ok((view(&row)?, Some(audit)))
}
