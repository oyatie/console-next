// SPDX-License-Identifier: LicenseRef-Proprietary
//! Certificate HTTP surface; the adapter owns every authorization and transaction.
use axum::{
    Extension, Json, Router,
    extract::Request,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use console_hr_adapter_postgres::{
    HrError, HrService,
    certificates::{
        Certificate, CertificateActionRequest, CertificateListQuery, CertificatePage,
        CertificateSettings, CertificateSettingsRequest, CertificateSettingsView,
        IssueCertificateRequest,
    },
};
use console_platform_authz::Principal;
use serde_json::{Value, json};
use tracing::Instrument;
use uuid::Uuid;

pub const CERTIFICATES_PATH: &str = "/api/v1/hr/certificates";
pub const CERTIFICATE_PATH: &str = "/api/v1/hr/certificates/{id}";
pub const CERTIFICATE_VOID_PATH: &str = "/api/v1/hr/certificates/{id}/void";
pub const CERTIFICATE_REISSUE_PATH: &str = "/api/v1/hr/certificates/{id}/reissue";
pub const CERTIFICATE_SETTINGS_PATH: &str = "/api/v1/hr/certificate-settings";
pub const CERTIFICATE_ROUTE_PATHS: &[&str] = &[
    CERTIFICATES_PATH,
    CERTIFICATE_PATH,
    CERTIFICATE_VOID_PATH,
    CERTIFICATE_REISSUE_PATH,
    CERTIFICATE_SETTINGS_PATH,
];
pub fn router(hr: HrService) -> Router {
    Router::new()
        .route(CERTIFICATES_PATH, get(list).post(issue))
        .route(CERTIFICATE_PATH, get(read))
        .route(CERTIFICATE_VOID_PATH, axum::routing::post(void))
        .route(CERTIFICATE_REISSUE_PATH, axum::routing::post(reissue))
        .route(CERTIFICATE_SETTINGS_PATH, get(settings).put(set_settings))
        .route_layer(middleware::from_fn(observe))
        .with_state(hr)
}
// A single wrapper covers extraction refusals too, and keeps subject ids out of metric labels.
async fn observe(req: Request, next: Next) -> Response {
    let path = req
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map_or("unknown", |p| p.as_str())
        .to_owned();
    let method = req.method().as_str().to_owned();
    let started = std::time::Instant::now();
    let response = next
        .run(req)
        .instrument(tracing::info_span!("hr_certificate",route=%path,method=%method))
        .await;
    metrics::counter!("hr_certificate_requests_total","route"=>path.clone(),"method"=>method.clone(),"status"=>response.status().as_u16().to_string()).increment(1);
    metrics::histogram!("hr_certificate_request_duration_seconds","route"=>path,"method"=>method)
        .record(started.elapsed().as_secs_f64());
    response
}
struct Error(HrError);
impl From<HrError> for Error {
    fn from(e: HrError) -> Self {
        Self(e)
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let support = Uuid::new_v4().to_string();
        tracing::warn!(support_ref=%support,code=self.0.code,status=self.0.status.as_u16(),"certificate request refused");
        let mut error = json!({"code":self.0.code,"message":self.0.message,"trace_id":support});
        if let Some(refusals) = self.0.refusals {
            error["refusals"] = refusals;
        }
        (self.0.status, Json(json!({"error":error}))).into_response()
    }
}
fn key(h: &HeaderMap) -> Option<String> {
    h.get("Idempotency-Key")
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned)
}
async fn issue(
    State(hr): State<HrService>,
    Extension(p): Extension<Principal>,
    h: HeaderMap,
    Json(b): Json<IssueCertificateRequest>,
) -> Result<(StatusCode, Json<Value>), Error> {
    Ok((
        StatusCode::CREATED,
        Json(hr.issue_certificate(p, key(&h), b).await?),
    ))
}
async fn list(
    State(hr): State<HrService>,
    Extension(p): Extension<Principal>,
    Query(q): Query<CertificateListQuery>,
) -> Result<Json<CertificatePage>, Error> {
    Ok(Json(hr.certificates(p, q).await?))
}
async fn read(
    State(hr): State<HrService>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<Certificate>, Error> {
    Ok(Json(hr.certificate(p, id).await?))
}
async fn void(
    State(hr): State<HrService>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(b): Json<CertificateActionRequest>,
) -> Result<Json<Value>, Error> {
    Ok(Json(hr.void_certificate(p, id, key(&h), b).await?))
}
async fn reissue(
    State(hr): State<HrService>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(b): Json<CertificateActionRequest>,
) -> Result<(StatusCode, Json<Value>), Error> {
    Ok((
        StatusCode::CREATED,
        Json(hr.reissue_certificate(p, id, key(&h), b).await?),
    ))
}
async fn settings(
    State(hr): State<HrService>,
    Extension(p): Extension<Principal>,
) -> Result<Json<CertificateSettingsView>, Error> {
    Ok(Json(hr.certificate_settings(p).await?))
}
async fn set_settings(
    State(hr): State<HrService>,
    Extension(p): Extension<Principal>,
    Json(b): Json<CertificateSettingsRequest>,
) -> Result<Json<CertificateSettings>, Error> {
    Ok(Json(hr.set_certificate_settings(p, b).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn refusal_includes_a_support_reference_and_preserves_code() {
        let response = Error(HrError {
            status: StatusCode::FORBIDDEN,
            code: "certificate_forbidden",
            message: "refused".into(),
            refusals: None,
        })
        .into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = axum::body::to_bytes(response.into_body(), 4096).await;
        let body: Option<Value> = bytes
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        assert_eq!(
            body.as_ref()
                .and_then(|body| body["error"]["code"].as_str()),
            Some("certificate_forbidden")
        );
        assert!(
            body.as_ref()
                .and_then(|body| body["error"]["trace_id"].as_str())
                .is_some_and(|id| Uuid::parse_str(id).is_ok())
        );
    }
}
