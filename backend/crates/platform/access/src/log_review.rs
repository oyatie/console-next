// SPDX-License-Identifier: LicenseRef-Proprietary
//! Sensitive access actions covered by monthly 접속기록 점검.
pub mod list;
pub mod record;
pub const MAX_PAGE_SIZE: i64 = 200;
/// Stable wire codes, in the SQL predicate order.
pub const FLAG_CODES: [&str; 6] = [
    "download",
    "download_repeat",
    "off_hours",
    "bulk_subjects",
    "sensitive_read",
    "repeated_denial",
];
/// Kept aligned with the real writers by `app/tests/access_log_review.rs`.
pub const SENSITIVE_READS: &[&str] = &[
    "employee.rrn_reveal",
    "employee.field_reveal",
    "employee.record.restricted_read",
];
