// SPDX-License-Identifier: LicenseRef-Proprietary
//! Process resource ceilings for the policy bulk endpoint, independent of tenant policy.

/// Bound evaluator calls and append-only decision writes in one request.
pub(super) const BULK_CHECKS_MAX: usize = 200;
/// Bound repeated subject data across all checks, including roles and clearance keys.
pub(super) const BULK_SUBJECT_WORK_BYTES_MAX: usize = 2 * 1024 * 1024;
