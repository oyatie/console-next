// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{BranchId, P1DispatchId, Timestamp, WorkOrderId};
use serde::{Deserialize, Serialize};

/// One pending P1 offer for the signed-in mechanic (UI-M3 overview inbox): a
/// BROADCASTING dispatch that fanned out to the caller, still inside its
/// accept window, with no response from the caller yet. Person-scoped by
/// construction — the owner is always bound from the authenticated principal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MyDispatchOffer {
    pub dispatch_id: P1DispatchId,
    pub work_order_id: WorkOrderId,
    pub branch_id: BranchId,
    pub request_no: String,
    pub site_name: String,
    pub symptom: String,
    #[serde(with = "time::serde::rfc3339")]
    pub accept_window_started_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub accept_window_ends_at: Timestamp,
}

/// Internal person-scoped projection for immutable action-inbox traversal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInboxDispatchOffer {
    pub dispatch_id: P1DispatchId,
    pub work_order_id: WorkOrderId,
    pub request_no: String,
    pub created_at: Timestamp,
    pub accept_window_started_at: Timestamp,
    pub accept_window_ends_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MyDispatchOfferPage {
    pub items: Vec<MyDispatchOffer>,
}
