//! 인적사항 extra routes (MR-34, lane EMP-FACTS). INTEG mounts [`router`]
//! inside the authenticated HR router with the object store (the storage
//! config's primary bucket) and registers [`PERSONAL_FACTS_ROUTE_PATHS`].
//! Changes of these items are corrections: `PATCH /employees/{id}` (one by
//! one) and `POST /employees/register-facts/bulk` (the import profile).
//!
//! 사진: `POST …/photo-uploads` answers a presigned PUT (type and size are
//! signed), the browser PUTs the bytes, `POST …/photo-uploads/{upload_id}/confirm`
//! HEADs the object, then `PATCH /employees/{id} {"photo": upload_id}`. Without
//! object storage the upload routes answer 503 and the read serves no URL.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::personal_facts::photo::{PhotoUpload, PhotoUploadRequest};
use console_hr_adapter_postgres::personal_facts::read::PersonalFactsResponse;
use console_hr_adapter_postgres::{HrError, HrService};
use console_platform_authz::Principal;
use console_platform_storage::{
    PresignGetRequest, PresignPutRequest, PresignedUpload, S3ObjectStore,
};
use serde::Serialize;
use uuid::Uuid;

use crate::HrApiError;

pub const PERSONAL_FACTS_PATH: &str = "/api/v1/employees/{id}/personal-facts";
pub const PHOTO_UPLOADS_PATH: &str = "/api/v1/employees/{id}/photo-uploads";
pub const PHOTO_UPLOAD_CONFIRM_PATH: &str =
    "/api/v1/employees/{id}/photo-uploads/{upload_id}/confirm";
pub const PERSONAL_FACTS_ROUTE_PATHS: &[&str] = &[
    PERSONAL_FACTS_PATH,
    PHOTO_UPLOADS_PATH,
    PHOTO_UPLOAD_CONFIRM_PATH,
];

/// How long a presigned PUT or GET stays valid.
const PRESIGN_TTL: Duration = Duration::from_secs(300);

/// The object store and bucket photos live in.
#[derive(Clone)]
pub struct PhotoStore {
    pub store: Arc<dyn S3ObjectStore>,
    pub bucket: String,
}

#[derive(Clone)]
struct PersonalFactsState {
    hr: HrService,
    photos: Option<PhotoStore>,
}

pub fn router(hr: HrService, photos: Option<PhotoStore>) -> Router {
    Router::new()
        .route(PERSONAL_FACTS_PATH, get(read))
        .route(PHOTO_UPLOADS_PATH, post(issue))
        .route(PHOTO_UPLOAD_CONFIRM_PATH, post(confirm))
        .with_state(PersonalFactsState { hr, photos })
}

fn refusal(status: StatusCode, code: &'static str, message: &str) -> HrApiError {
    HrApiError(HrError {
        errors: None,
        status,
        code,
        message: message.to_owned(),
        refusals: None,
    })
}

fn photos(state: &PersonalFactsState) -> Result<&PhotoStore, HrApiError> {
    state.photos.as_ref().ok_or_else(|| {
        refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "photo_storage_unavailable",
            "photo storage is not configured on this server",
        )
    })
}

async fn read(
    State(state): State<PersonalFactsState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<PersonalFactsResponse>, HrApiError> {
    let mut facts = state.hr.personal_facts(principal, id).await?;
    if let (Some(photo), Some(photos)) = (facts.photo.as_mut(), state.photos.as_ref()) {
        // No URL rather than a failed read when storage is down.
        photo.url = photos
            .store
            .presign_get(PresignGetRequest {
                bucket: photos.bucket.clone(),
                key: photo.object_key.clone(),
                expires_in: PRESIGN_TTL,
            })
            .await
            .ok();
    }
    Ok(Json(facts))
}

#[derive(Debug, Serialize)]
struct IssuedPhotoUpload {
    #[serde(flatten)]
    upload: PhotoUpload,
    /// PUT the bytes here with these headers (type and length are signed).
    put: PresignedUpload,
}

async fn issue(
    State(state): State<PersonalFactsState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<PhotoUploadRequest>,
) -> Result<Json<IssuedPhotoUpload>, HrApiError> {
    let photos = photos(&state)?;
    let upload = state.hr.issue_photo_upload(principal, id, body).await?;
    let put = photos
        .store
        .presign_put(PresignPutRequest {
            bucket: photos.bucket.clone(),
            key: upload.object_key.clone(),
            content_type: upload.content_type.clone(),
            size_bytes: upload.byte_size,
            checksum_sha256: None,
            expires_in: PRESIGN_TTL,
        })
        .await
        .map_err(|_| {
            refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "photo_storage_unavailable",
                "the photo upload could not be prepared; try again",
            )
        })?;
    Ok(Json(IssuedPhotoUpload { upload, put }))
}

async fn confirm(
    State(state): State<PersonalFactsState>,
    Extension(principal): Extension<Principal>,
    Path((id, upload_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<PhotoUpload>, HrApiError> {
    let photos = photos(&state)?;
    let upload = state
        .hr
        .photo_upload(principal.clone(), id, upload_id)
        .await?;
    if upload.confirmed {
        return Ok(Json(upload));
    }
    let head = photos
        .store
        .head_object(photos.bucket.clone(), upload.object_key.clone())
        .await
        .map_err(|_| {
            refusal(
                StatusCode::CONFLICT,
                "photo_upload_missing",
                "the photo was not found in storage; upload it, then confirm again",
            )
        })?;
    if head.size_bytes != upload.byte_size {
        return Err(refusal(
            StatusCode::CONFLICT,
            "photo_upload_size_mismatch",
            "the stored photo is not the size that was declared; upload it again",
        ));
    }
    Ok(Json(
        state.hr.confirm_photo_upload(principal, upload).await?,
    ))
}
