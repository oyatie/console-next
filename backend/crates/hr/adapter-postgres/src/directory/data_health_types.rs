// SPDX-License-Identifier: LicenseRef-Proprietary
//! Request and response contracts for `GET /api/v1/hr/people/data-health`.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Default, Deserialize)]
pub struct DataHealthQuery {
    pub category: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DataHealthCohort {
    pub total: i64,
    pub active: i64,
    pub on_leave: i64,
    pub pre_hire: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegisterCategoryMissing {
    pub birth: i64,
    pub job: i64,
    pub hire: i64,
    pub contract_end: i64,
    pub sex: i64,
    pub address: i64,
    pub career: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatutoryRegisterHealth {
    pub complete_count: i64,
    pub incomplete_count: i64,
    pub missing_by_category: RegisterCategoryMissing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdTypeBreakdown {
    pub rrn: i64,
    pub arc: i64,
    pub domestic_residence: i64,
    pub not_issued: i64,
    pub unset: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdHealthSummary {
    pub rrn_recorded: i64,
    pub not_issued: i64,
    pub missing: i64,
    pub by_type: IdTypeBreakdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlacementHealthSummary {
    pub placed: i64,
    pub unplaced: i64,
    pub department_missing: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BankAccountHealth {
    pub registered: i64,
    pub missing: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdentityReviewHealth {
    pub needs_review: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FailedActionsHealth {
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DataHealthDrilldownItem {
    pub employee_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub employee_number: Option<String>,
    pub employment_status: String,
    pub missing_categories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LatestImportRunHealth {
    pub run_id: Uuid,
    pub status: String,
    pub candidate_rows: i32,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub applied_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PeopleDataHealthResponse {
    pub cohort: DataHealthCohort,
    pub statutory_register: StatutoryRegisterHealth,
    pub id_summary: IdHealthSummary,
    pub placement_summary: PlacementHealthSummary,
    pub bank_account: BankAccountHealth,
    pub identity_review: IdentityReviewHealth,
    pub failed_actions: FailedActionsHealth,
    pub drilldown_items: Vec<DataHealthDrilldownItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_import: Option<LatestImportRunHealth>,
}
