// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub(super) struct AttendanceImportSummaryItem {
    pub(super) run_id: Uuid,
    pub(super) status: String,
    pub(super) source_filename: String,
    pub(super) source_format: String,
    pub(super) source_sha256: String,
    pub(super) input_rows: i32,
    pub(super) candidate_rows: i32,
    pub(super) preserved_rows: i32,
    pub(super) dry_run_summary: Value,
    pub(super) apply_summary: Value,
    #[serde(with = "console_kernel_core::timestamp")]
    pub(super) created_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "console_kernel_core::timestamp::option")]
    pub(super) applied_at: Option<OffsetDateTime>,
}
