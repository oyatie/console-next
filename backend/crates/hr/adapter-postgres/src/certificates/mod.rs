// SPDX-License-Identifier: LicenseRef-Proprietary
//! Numbered, immutable certificates. Only requested facts enter the issued snapshot.
mod access;
mod commands;
mod facts;
mod read;
mod seal;
mod settings;
mod validation;

use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use settings::{CertificateSettings, CertificateSettingsRequest, CertificateSettingsView};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssueCertificateRequest {
    pub employee_id: Uuid,
    #[serde(deserialize_with = "deserialize_certificate_kind")]
    pub kind: String,
    pub items: Vec<String>,
    pub purpose: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CertificateActionRequest {
    pub reason: String,
}
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CertificateListQuery {
    pub employee_id: Option<Uuid>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct Certificate {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub certificate_no: String,
    pub kind: String,
    pub items: Vec<String>,
    pub purpose: String,
    pub snapshot: Value,
    pub replaces_id: Option<Uuid>,
    pub issued_by: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub issued_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub voided_at: Option<OffsetDateTime>,
    pub void_reason: Option<String>,
}
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CertificateSummary {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub certificate_no: String,
    pub name: String,
    pub kind: String,
    pub purpose: String,
    pub replaces_id: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub issued_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub voided_at: Option<OffsetDateTime>,
}
#[derive(Debug, Serialize)]
pub struct CertificatePage {
    pub items: Vec<CertificateSummary>,
    pub next_cursor: Option<String>,
}

fn refused(status: http::StatusCode, code: &'static str, message: &str) -> crate::HrError {
    crate::HrError {
        status,
        code,
        message: message.into(),
        refusals: None,
    }
}
fn invalid(message: &str) -> crate::HrError {
    refused(
        http::StatusCode::UNPROCESSABLE_ENTITY,
        "certificate_invalid",
        message,
    )
}
fn not_found() -> crate::HrError {
    refused(
        http::StatusCode::NOT_FOUND,
        "not_found",
        "certificate or employee not found",
    )
}
fn state_conflict() -> crate::HrError {
    refused(
        http::StatusCode::CONFLICT,
        "certificate_state_conflict",
        "certificate or settings changed; reload before continuing",
    )
}

fn deserialize_certificate_kind<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["EMPLOYMENT", "CAREER", "EXIT"],
    )
}
#[cfg(test)]
mod tests {
    #[test]
    fn unknown_certificate_kind_is_refused_at_the_json_boundary() {
        let request = serde_json::json!({"employee_id":uuid::Uuid::new_v4(),"kind":"OTHER","items":["period"],"purpose":"제출용"});
        assert!(serde_json::from_value::<super::IssueCertificateRequest>(request).is_err());
    }
    #[test]
    fn settings_accept_an_entity_id_and_refuse_a_typed_issuer() {
        let valid = serde_json::json!({"legal_entity_id":uuid::Uuid::new_v4(),"prefix":"HR","width":6,"seal_text":"대표이사","expected_version":0});
        assert!(serde_json::from_value::<super::CertificateSettingsRequest>(valid.clone()).is_ok());
        let mut typed = valid;
        typed["issuer_name"] = serde_json::json!("display copy");
        assert!(serde_json::from_value::<super::CertificateSettingsRequest>(typed).is_err());
    }
}
