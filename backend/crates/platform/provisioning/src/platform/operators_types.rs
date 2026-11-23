// SPDX-License-Identifier: LicenseRef-Proprietary
//! Types and canonical BW-29 step-up payload hashes for platform operator management.

use crate::{BootstrapToken, ProvisioningError};
use aws_lc_rs::digest::{SHA256, digest};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlatformOperatorStatus {
    PendingEnrolment,
    Active,
    Revoked,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlatformOperatorSummary {
    pub user_id: Uuid,
    pub display_name: String,
    pub sign_in_id: Option<String>,
    pub is_active: bool,
    pub has_passkey: bool,
    pub device_bound_passkey: bool,
    pub status: PlatformOperatorStatus,
    pub invited_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub invite_expires_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformOperatorInviteOutcome {
    pub operator: PlatformOperatorSummary,
    pub invite_token: BootstrapToken,
    pub expires_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvitePlatformOperatorInput {
    pub id: Uuid,
    pub display_name: String,
    pub login: Option<String>,
}

pub struct PlatformOperatorStepUp;

impl PlatformOperatorStepUp {
    pub fn invite_payload_hash(
        id: Uuid,
        display_name: &str,
        login: Option<&str>,
    ) -> Result<String, ProvisioningError> {
        sha256_json(&(
            "platform_operator",
            "invite",
            id,
            display_name.trim(),
            login.map(str::trim).unwrap_or(""),
        ))
    }

    pub fn reissue_payload_hash(id: Uuid) -> Result<String, ProvisioningError> {
        sha256_json(&("platform_operator", "reissue", id))
    }

    pub fn revoke_payload_hash(
        id: Uuid,
        reason: Option<&str>,
    ) -> Result<String, ProvisioningError> {
        sha256_json(&(
            "platform_operator",
            "revoke",
            id,
            reason.map(str::trim).unwrap_or(""),
        ))
    }
}

fn sha256_json<T: Serialize>(value: &T) -> Result<String, ProvisioningError> {
    let encoded = serde_json::to_vec(value)?;
    let sum = digest(&SHA256, &encoded);
    Ok(sum.as_ref().iter().map(|b| format!("{b:02x}")).collect())
}
