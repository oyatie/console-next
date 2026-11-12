// SPDX-License-Identifier: LicenseRef-Proprietary
use super::ChangeRequestKind;
use time::OffsetDateTime;

/// The inbox decision classes with registered bulk and step-up policies.
/// Key names keep this domain independent of the settings implementation.
#[must_use]
pub const fn approval_class(kind: ChangeRequestKind) -> Option<&'static str> {
    match kind {
        ChangeRequestKind::ProfileCorrection => Some("approval.policy.people_correction"),
        ChangeRequestKind::IdentityReview => Some("approval.policy.identity_merge"),
        ChangeRequestKind::EmployeeVoid => Some("approval.policy.registration_void"),
        ChangeRequestKind::ImportRollback => Some("approval.policy.import_rollback"),
        _ => None,
    }
}

/// Closing a request changes the token; settings and unrelated rows do not.
#[must_use]
pub fn decision_version(status: &str, decided_at: Option<OffsetDateTime>) -> String {
    format!(
        "{status}:{}",
        decided_at
            .map(|at| at.unix_timestamp_nanos().to_string())
            .unwrap_or_default()
    )
}
