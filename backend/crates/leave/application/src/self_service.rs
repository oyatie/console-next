// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-service leave read models (`team-overlap` and `approval-preview`).

use console_kernel_core::{Date, UserId};
use console_leave_domain::LeaveBalanceAmount;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelfLeaveFilingState {
    Ready,
    HomeBranchRequired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelfLeaveBalanceView {
    pub employee_id: Uuid,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit: Option<String>,
    pub accrued_units: Option<LeaveBalanceAmount>,
    pub used_units: Option<LeaveBalanceAmount>,
    pub remaining_units: Option<LeaveBalanceAmount>,
    pub filing_state: SelfLeaveFilingState,
    pub home_branch_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct SelfLeaveTeamOverlapQuery {
    pub requester: UserId,
    pub start_date: Date,
    pub end_date: Date,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamOverlapMemberView {
    pub employee_id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelfLeaveTeamOverlapView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit: Option<String>,
    pub active_count: i64,
    pub out_count: i64,
    pub members_out: Vec<TeamOverlapMemberView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaveApprovalPreviewStepView {
    pub order: i32,
    pub step_kind: String,
    pub role_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approver_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approver_position: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelfLeaveApprovalPreviewView {
    pub filing_state: SelfLeaveFilingState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home_branch_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit: Option<String>,
    pub steps: Vec<LeaveApprovalPreviewStepView>,
}
