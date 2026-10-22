// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};

/// Branch-scoped user listing. The adapter resolves the caller's scope and only
/// returns users that share at least one in-scope branch (or all users for a
/// cross-branch caller).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserListQuery {
    pub include_inactive: bool,
    /// Accounts whose committed decisions used account identity and still lack a person link.
    #[serde(default)]
    pub independence_review_required: bool,
    /// Page size; the adapter clamps to `1..=200` and defaults a missing value.
    pub limit: Option<i64>,
    /// Zero-based row offset into the scope-ordered roster for offset
    /// pagination. `None` starts at the first page.
    pub offset: Option<i64>,
}
