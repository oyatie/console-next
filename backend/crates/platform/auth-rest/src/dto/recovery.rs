// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::dto::passkey::StepUpAssertion;
use console_platform_provisioning::ops_self_recovery::{
    RecoveryChannel, RecoveryCodesBatch, RecoveryCodesSummary, RecoveryContactStatus,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

#[derive(Debug, Serialize)]
pub(crate) struct RecoveryStatusResponse {
    pub(crate) eligible: bool,
    pub(crate) is_tenant_ops: bool,
    pub(crate) holder_count: i64,
    pub(crate) max_holders: i64,
    pub(crate) contact: Option<RecoveryContactStatus>,
    pub(crate) codes: RecoveryCodesSummary,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpsertRecoveryContactRequest {
    pub(crate) channel: RecoveryChannel,
    pub(crate) value: String,
    pub(crate) consent_accepted: bool,
    #[serde(default)]
    pub(crate) step_up: Option<StepUpAssertion>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct GenerateRecoveryCodesRequest {
    #[serde(default)]
    pub(crate) step_up: Option<StepUpAssertion>,
}

pub(crate) type GenerateRecoveryCodesResponse = RecoveryCodesBatch;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecoveryChallengeRequest {
    pub(crate) identifier: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct RecoveryChallengeResponse {
    pub(crate) sent: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecoveryRedeemRequest {
    pub(crate) recovery_code: String,
    pub(crate) contact_code: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct RecoveryRedeemResponse {
    pub(crate) access_token: String,
    pub(crate) refresh_token: Option<String>,
    pub(crate) token_type: &'static str,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) refresh_expires_at: OffsetDateTime,
    pub(crate) requires_passkey_setup: bool,
    pub(crate) privacy_consent_accepted: bool,
    pub(crate) cancelled_recovery_request: bool,
}
