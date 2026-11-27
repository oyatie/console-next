// SPDX-License-Identifier: LicenseRef-Proprietary
use super::date;
use serde::Serialize;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct PayrollRunSummary {
    pub id: Uuid,
    pub legal_entity_id: Option<Uuid>,
    pub pay_group_id: Option<Uuid>,
    pub kind: Option<String>,
    pub attribution_month: Option<String>,
    #[serde(with = "date::option")]
    pub pay_date: Option<Date>,
    #[serde(with = "date")]
    pub period_start: Date,
    #[serde(with = "date")]
    pub period_end: Date,
    #[serde(with = "date::option")]
    pub variable_period_start: Option<Date>,
    #[serde(with = "date::option")]
    pub variable_period_end: Option<Date>,
    #[serde(with = "date::option", skip_serializing_if = "Option::is_none")]
    pub attendance_cutoff_date: Option<Date>,
    pub source_label: String,
    pub status: String,
    pub calculation_enabled: bool,
    pub created_by: Option<Uuid>,
    pub approved_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub approved_at: Option<OffsetDateTime>,
    pub close_receipt: Option<serde_json::Value>,
    pub submitted_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub submitted_at: Option<OffsetDateTime>,
    pub decided_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub decided_at: Option<OffsetDateTime>,
    pub decision_reason: Option<String>,
    pub approval_ref: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}
