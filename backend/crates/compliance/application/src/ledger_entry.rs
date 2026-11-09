// SPDX-License-Identifier: LicenseRef-Proprietary
use console_compliance_domain::LocationConsentState;
use console_kernel_core::{BranchId, Timestamp, UserId};
use serde::{Deserialize, Serialize};

/// One audited consent lifecycle transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocationConsentLedgerEntry {
    pub id: String,
    pub consent_id: String,
    pub user_id: UserId,
    pub branch_id: BranchId,
    pub actor: Option<UserId>,
    pub action: String,
    pub from_status: LocationConsentState,
    pub to_status: LocationConsentState,
    #[serde(with = "console_kernel_core::timestamp")]
    pub occurred_at: Timestamp,
    #[serde(with = "console_kernel_core::timestamp")]
    pub created_at: Timestamp,
}
