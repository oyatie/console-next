// SPDX-License-Identifier: LicenseRef-Proprietary
//! Sensitive access actions covered by monthly 접속기록 점검.
/// Kept aligned with the real writers by `app/tests/access_log_review.rs`.
pub const SENSITIVE_READS: &[&str] = &[
    "employee.rrn_reveal",
    "employee.field_reveal",
    "employee.record.restricted_read",
];
