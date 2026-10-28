//! Kept originals: upload, list, read back; and the creates/revises that
//! attach one (`document_id`) to the 법인 or 사업자등록 it backs.

use axum::Json;
use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use console_entity_application::{Actor, EntityDocumentView, Target};
use console_entity_domain::Refusal;
use console_entity_domain::document::{MAX_BYTES, validate_upload};
use console_entity_domain::legal_entity::LegalEntityInput;
use console_entity_domain::registration::RegistrationInput;
use console_kernel_core::ErrorKind;
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_domain::{SettingKey, SettingValue};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{Need, actor, manager, read_gate};
use crate::error::RestError;
use crate::handlers::ReviseRegistrationBody;

type Result<T> = std::result::Result<T, RestError>;

/// The multipart body may carry the file plus its form fields.
pub(crate) const UPLOAD_BODY_LIMIT: usize = MAX_BYTES + 64 * 1024;

/// `retention.entity_registration_document` in force for `entity`, in years.
async fn retention_years(
    s: &EntityRestState,
    a: &Actor,
    entity: Option<Uuid>,
) -> Result<Option<i64>> {
    let all = PgSettingsStore::new(s.store.pool().clone())
        .list_effective(a.org, entity)
        .await
        .map_err(|err| {
            tracing::error!(error = ?err, "retention setting unreadable");
            RestError(Refusal::new(
                ErrorKind::Internal,
                "internal",
                "internal server error",
            ))
        })?;
    Ok(all
        .items
        .into_iter()
        .find(|e| e.key == SettingKey::RetentionEntityRegistrationDocument)
        .and_then(|e| e.value)
        .and_then(|v| match v {
            SettingValue::Int(years) => Some(years),
            _ => None,
        }))
}

async fn with_retention(
    s: &EntityRestState,
    a: &Actor,
    doc: EntityDocumentView,
) -> Result<EntityDocumentView> {
    let years = match doc.superseded_at {
        Some(_) => retention_years(s, a, doc.legal_entity_id).await?,
        None => None,
    };
    Ok(doc.with_retention(years))
}

fn bad_upload(field: &'static str, code: &'static str) -> RestError {
    RestError(Refusal::field(field, code))
}

pub(crate) async fn upload(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    mut form: Multipart,
) -> Result<Response> {
    // Fail closed before reading the body: only entity writers keep evidence.
    let (a, _) = actor(&s, &h, Need::Structure, Target::Tenant).await?;
    let (mut kind, mut file_name, mut bytes) = (None, None, Vec::new());
    while let Some(mut field) = form
        .next_field()
        .await
        .map_err(|_| bad_upload("file", "multipart_invalid"))?
    {
        match field.name() {
            Some("kind") => {
                kind = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| bad_upload("kind", "invalid_option"))?,
                )
            }
            Some("file") => {
                file_name = field.file_name().map(ToOwned::to_owned);
                // Bound the read as it streams, never after buffering it all.
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|_| bad_upload("file", "file_too_large"))?
                {
                    if bytes.len() + chunk.len() > MAX_BYTES {
                        return Err(bad_upload("file", "file_too_large"));
                    }
                    bytes.extend_from_slice(&chunk);
                }
            }
            _ => {}
        }
    }
    let doc = validate_upload(kind.as_deref(), file_name.as_deref(), bytes)?;
    let saved = s.store.upload_document(&a, doc).await?;
    Ok((
        StatusCode::CREATED,
        Json(with_retention(&s, &a, saved).await?),
    )
        .into_response())
}

pub(crate) async fn get(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (a, _, gate) = read_gate(&s, &h, Need::Read, Target::Tenant).await?;
    let doc = s.store.get_document(&a, id).await?;
    crate::access_log::record(
        &s,
        crate::access_log::event(
            &gate.principal,
            "entity_document.metadata_read",
            id.to_string(),
            &[format!("entity_documents:{id}")],
        )?,
    )
    .await?;
    Ok(Json(with_retention(&s, &a, doc).await?).into_response())
}

pub(crate) async fn list(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(entity): Path<Uuid>,
) -> Result<Response> {
    let (a, _, gate) = read_gate(&s, &h, Need::Read, Target::Entity(entity)).await?;
    let docs = s.store.list_documents(&a, entity).await?;
    let subjects = docs
        .iter()
        .map(|doc| format!("entity_documents:{}", doc.id))
        .collect::<Vec<_>>();
    crate::access_log::record(
        &s,
        crate::access_log::event(
            &gate.principal,
            "entity_document.list_read",
            entity.to_string(),
            &subjects,
        )?,
    )
    .await?;
    let years = if docs.iter().any(|d| d.superseded_at.is_some()) {
        retention_years(&s, &a, Some(entity)).await?
    } else {
        None
    };
    let items: Vec<_> = docs.into_iter().map(|d| d.with_retention(years)).collect();
    Ok(Json(json!({ "items": items })).into_response())
}

/// The kept bytes, for the restricted readers (the original carries the
/// representative's name). `private, no-store`; every read is audited.
pub(crate) async fn content(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (a, personal, gate) = match read_gate(&s, &h, Need::Read, Target::Tenant).await {
        Ok(gate) => gate,
        Err(error) => {
            return Err(
                crate::access_log::refused(&s, &h, "entity_document.read", id, error).await,
            );
        }
    };
    if !personal {
        let refusal = RestError(Refusal::forbidden(
            "forbidden",
            "the original is restricted to entity administrators",
        ));
        return Err(crate::access_log::refused(&s, &h, "entity_document.read", id, refusal).await);
    }
    let access = crate::access_log::event(
        &gate.principal,
        "entity_document.read",
        id.to_string(),
        &[format!("entity_documents:{id}")],
    )?;
    let doc = s.store.document_content(&a, id, access).await?;
    let mut response = Response::new(Body::from(doc.bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Ok(v) = HeaderValue::from_str(&doc.content_type) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    // RFC 6266 / 5987: the name travels percent-encoded, never raw.
    let encoded: String = doc
        .file_name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b".-_".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    if let Ok(v) = HeaderValue::from_str(&format!("inline; filename*=UTF-8''{encoded}")) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(response)
}

/// A create or revise body plus the document it attaches.
#[derive(Debug, Deserialize)]
pub(crate) struct WithDocument<T> {
    #[serde(default)]
    document_id: Option<Uuid>,
    #[serde(default)]
    check_preview: Option<console_entity_application::registration_check::PreviewAcceptance>,
    #[serde(flatten)]
    body: T,
}

pub(crate) async fn create_entity(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Json(b): Json<WithDocument<LegalEntityInput>>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Tenant).await?;
    let saved = s.store.create_entity(&a, b.body).await?;
    // Retry-safe: the create replays by Idempotency-Key, the attach is a no-op twice.
    if let Some(doc) = b.document_id {
        s.store
            .attach_document(&a, doc, saved.record.id, None)
            .await?;
    }
    Ok((StatusCode::CREATED, Json(saved)).into_response())
}

pub(crate) async fn create_registration(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(entity): Path<Uuid>,
    Json(b): Json<WithDocument<RegistrationInput>>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Entity(entity)).await?;
    let saved = s
        .store
        .create_registration_checked(&a, entity, b.body, b.document_id, b.check_preview)
        .await?;
    Ok((StatusCode::CREATED, Json(saved)).into_response())
}

/// A revision; with `document_id`, the new original is attached in the same
/// transaction, linked to the revision and supersedes the one kept before.
pub(crate) async fn revise_registration(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<WithDocument<ReviseRegistrationBody>>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Registration(id)).await?;
    let ReviseRegistrationBody { rev, status } = b.body;
    let saved = s
        .store
        .revise_registration_evidenced(&a, id, rev, status, b.document_id)
        .await?;
    Ok(Json(saved).into_response())
}
