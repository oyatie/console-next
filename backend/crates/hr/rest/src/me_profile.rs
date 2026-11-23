// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-service HR profile (`/api/v1/me/profile*`) and certificates (`/api/v1/me/certificates*`).

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::certificates::{
    Certificate, CertificatePage, SelfCertificateListQuery, SelfIssueCertificateRequest,
};
use console_hr_adapter_postgres::me_profile::{
    CreateSelfChangeRequest, MeProfileResponse, SelfFieldRevealed, SelfRevealRequest,
    UpdateMeProfileRequest,
};
use console_hr_adapter_postgres::requests::ChangeRequestResponse;
use console_platform_auth::PasskeyService;
use console_platform_authz::Principal;
use serde_json::Value;
use uuid::Uuid;

use crate::HrApiError;

pub const ME_PROFILE_PATH: &str = "/api/v1/me/profile";
pub const ME_PROFILE_REVEAL_PATH: &str = "/api/v1/me/profile/reveal";
pub const ME_PROFILE_CHANGE_REQUESTS_PATH: &str = "/api/v1/me/profile/change-requests";
pub const ME_CERTIFICATES_PATH: &str = "/api/v1/me/certificates";
pub const ME_CERTIFICATE_PATH: &str = "/api/v1/me/certificates/{id}";

pub const ME_PROFILE_ROUTE_PATHS: &[&str] = &[
    ME_PROFILE_PATH,
    ME_PROFILE_REVEAL_PATH,
    ME_PROFILE_CHANGE_REQUESTS_PATH,
    ME_CERTIFICATES_PATH,
    ME_CERTIFICATE_PATH,
];

#[derive(Clone)]
struct MeProfileState {
    hr: HrService,
    passkeys: Option<PasskeyService>,
}

pub fn router(hr: HrService, passkeys: Option<PasskeyService>) -> Router {
    Router::new()
        .route(ME_PROFILE_PATH, get(get_profile).patch(patch_profile))
        .route(ME_PROFILE_REVEAL_PATH, post(reveal_profile))
        .route(ME_PROFILE_CHANGE_REQUESTS_PATH, post(create_change_request))
        .route(
            ME_CERTIFICATES_PATH,
            get(list_certificates).post(issue_certificate),
        )
        .route(ME_CERTIFICATE_PATH, get(get_certificate))
        .with_state(MeProfileState { hr, passkeys })
}

fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("Idempotency-Key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

async fn get_profile(
    State(s): State<MeProfileState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<MeProfileResponse>, HrApiError> {
    Ok(Json(s.hr.get_me_profile(principal).await?))
}

async fn patch_profile(
    State(s): State<MeProfileState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<UpdateMeProfileRequest>,
) -> Result<Json<MeProfileResponse>, HrApiError> {
    Ok(Json(s.hr.update_me_profile(principal, body).await?))
}

async fn reveal_profile(
    State(s): State<MeProfileState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<SelfRevealRequest>,
) -> Result<
    (
        [(axum::http::header::HeaderName, &'static str); 1],
        Json<SelfFieldRevealed>,
    ),
    HrApiError,
> {
    let revealed =
        s.hr.reveal_me_profile_field(principal, body, s.passkeys.as_ref())
            .await?;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(revealed),
    ))
}

async fn create_change_request(
    State(s): State<MeProfileState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateSelfChangeRequest>,
) -> Result<(StatusCode, Json<ChangeRequestResponse>), HrApiError> {
    Ok((
        StatusCode::CREATED,
        Json(
            s.hr.create_me_profile_change_request(principal, body)
                .await?,
        ),
    ))
}

async fn list_certificates(
    State(s): State<MeProfileState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<SelfCertificateListQuery>,
) -> Result<Json<CertificatePage>, HrApiError> {
    Ok(Json(s.hr.my_certificates(principal, query).await?))
}

async fn issue_certificate(
    State(s): State<MeProfileState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Json(body): Json<SelfIssueCertificateRequest>,
) -> Result<(StatusCode, Json<Value>), HrApiError> {
    Ok((
        StatusCode::CREATED,
        Json(
            s.hr.issue_my_certificate(principal, idempotency_key(&headers), body)
                .await?,
        ),
    ))
}

async fn get_certificate(
    State(s): State<MeProfileState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<Certificate>, HrApiError> {
    Ok(Json(s.hr.my_certificate(principal, id).await?))
}
