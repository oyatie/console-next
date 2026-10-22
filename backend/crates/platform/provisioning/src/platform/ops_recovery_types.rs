// SPDX-License-Identifier: LicenseRef-Proprietary
//! Same-holder recovery. Request locks serialize decisions and credential issuance.
use crate::{OpsRecoveryState, ProvisioningError};
use console_kernel_core::{OrgId, UserId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum OpsRecoveryCommand {
    Open {
        authoriser_role: String,
        authoriser_name: String,
        proofing_method: String,
        evidence_ref: String,
    },
    Approve,
    Issue,
    Cancel {
        reason: String,
    },
}
impl OpsRecoveryCommand {
    pub fn action(&self) -> &'static str {
        match self {
            Self::Open { .. } => "open",
            Self::Approve => "approve",
            Self::Issue => "issue",
            Self::Cancel { .. } => "cancel",
        }
    }
    pub fn payload_hash(&self, org: OrgId, id: Uuid) -> Result<String, ProvisioningError> {
        let (role, name, method, evidence, reason) = match self {
            Self::Open {
                authoriser_role,
                authoriser_name,
                proofing_method,
                evidence_ref,
            } => (
                authoriser_role.as_str(),
                authoriser_name.as_str(),
                proofing_method.as_str(),
                evidence_ref.as_str(),
                "",
            ),
            Self::Cancel { reason } => ("", "", "", "", reason.as_str()),
            _ => ("", "", "", "", ""),
        };
        let digest = Sha256::digest(serde_json::to_vec(&(
            org,
            id,
            self.action(),
            role,
            name,
            method,
            evidence,
            reason,
        ))?);
        Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}
#[derive(Debug, Clone, Copy)]
pub struct OpsRecoveryActor {
    pub user: UserId,
    pub org: OrgId,
    pub assertion: Uuid,
}
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct OpsRecoveryRequest {
    pub id: Uuid,
    pub target_user_id: Uuid,
    pub requested_by: Uuid,
    #[sqlx(default)]
    pub requested_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub opened_at: OffsetDateTime,
    pub approved_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub hold_until: Option<OffsetDateTime>,
    pub cancelled_by: Option<Uuid>,
    #[sqlx(default)]
    pub cancelled_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub cancelled_at: Option<OffsetDateTime>,
    pub cancel_reason: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub issued_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoriser_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoriser_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proofing_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_ref: Option<String>,
    #[serde(skip)]
    pub open_assertion: Uuid,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct OpsRecoveryRead {
    pub request: Option<OpsRecoveryRequest>,
    pub state: Option<OpsRecoveryState>,
    pub ops_enrolled: bool,
    pub ops_has_passkey: bool,
    pub recovery_available: bool,
    pub second_operator_available: bool,
    pub active_accounts: i64,
    pub hold_hours: i64,
    pub code_ttl_minutes: i64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct OpsRecoveryOutcome {
    pub request_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub otp: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
}
