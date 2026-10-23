//! The directory read of an account: its summary without the phone.

use serde::{Deserialize, Serialize};

use super::{AccountStatus, EmployeeLinkStatus, UserPage};
use console_identity_domain::Team;
use console_kernel_core::{BranchId, Timestamp, UserId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserSummary {
    pub id: UserId,
    #[serde(default)]
    pub person_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub principal_kind: String,
    pub display_name: String,
    /// The current sign-in ID `<아이디>@<회사 도메인>` (decisions #33). A label:
    /// the account is keyed by `id` only.
    pub sign_in_id: Option<String>,
    pub employee_id: Option<uuid::Uuid>,
    pub employee_name: Option<String>,
    pub employee_number: Option<String>,
    pub employee_company: Option<String>,
    pub employee_org_unit: Option<String>,
    pub employee_position: Option<String>,
    pub employee_identity_review_required: Option<bool>,
    pub employee_identity_resolution_confidence: Option<String>,
    pub employee_link_status: EmployeeLinkStatus,
    pub phone: Option<String>,
    pub team: Option<Team>,
    pub roles: Vec<String>,
    pub branch_ids: Vec<BranchId>,
    pub is_active: bool,
    /// The tenant's one ops account (break-glass; never a role). The console
    /// shows it as 운영 계정 and offers no 비활성화 on it.
    pub is_tenant_ops: bool,
    /// Whether the user has at least one enrolled passkey credential. A user can
    /// only actually sign in once this is true; until then they are pending setup.
    pub has_passkey: bool,
    /// Derived setup state (`is_active` + `has_passkey`) for the console badge.
    pub account_status: AccountStatus,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

/// Directory list item: [`UserSummary`] fields except `phone`.
///
/// Org user get/list still use [`UserSummary`] (phone included). Mapping
/// `phone: None` onto `UserSummary` still serializes a `phone` key; this type
/// omits the field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryPerson {
    pub id: UserId,
    #[serde(default)]
    pub person_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub principal_kind: String,
    pub display_name: String,
    pub sign_in_id: Option<String>,
    pub employee_id: Option<uuid::Uuid>,
    pub employee_name: Option<String>,
    pub employee_number: Option<String>,
    pub employee_company: Option<String>,
    pub employee_org_unit: Option<String>,
    pub employee_position: Option<String>,
    pub employee_identity_review_required: Option<bool>,
    pub employee_identity_resolution_confidence: Option<String>,
    pub employee_link_status: EmployeeLinkStatus,
    pub team: Option<Team>,
    pub roles: Vec<String>,
    pub branch_ids: Vec<BranchId>,
    pub is_active: bool,
    /// The tenant's one ops account (break-glass; never a role). The console
    /// shows it as 운영 계정 and offers no 비활성화 on it.
    pub is_tenant_ops: bool,
    pub has_passkey: bool,
    pub account_status: AccountStatus,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

impl From<UserSummary> for DirectoryPerson {
    fn from(user: UserSummary) -> Self {
        let UserSummary {
            id,
            person_id,
            principal_kind,
            display_name,
            sign_in_id,
            employee_id,
            employee_name,
            employee_number,
            employee_company,
            employee_org_unit,
            employee_position,
            employee_identity_review_required,
            employee_identity_resolution_confidence,
            employee_link_status,
            phone: _,
            team,
            roles,
            branch_ids,
            is_active,
            is_tenant_ops,
            has_passkey,
            account_status,
            created_at,
        } = user;
        Self {
            id,
            person_id,
            principal_kind,
            display_name,
            sign_in_id,
            employee_id,
            employee_name,
            employee_number,
            employee_company,
            employee_org_unit,
            employee_position,
            employee_identity_review_required,
            employee_identity_resolution_confidence,
            employee_link_status,
            team,
            roles,
            branch_ids,
            is_active,
            is_tenant_ops,
            has_passkey,
            account_status,
            created_at,
        }
    }
}

/// One page of directory people plus the unpaged `total` for the caller's
/// filtered branch scope. Items never include a `phone` field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryPage {
    pub items: Vec<DirectoryPerson>,
    pub limit: i64,
    pub offset: i64,
    pub total: i64,
}

impl From<UserPage> for DirectoryPage {
    fn from(page: UserPage) -> Self {
        let UserPage {
            items,
            limit,
            offset,
            total,
        } = page;
        Self {
            items: items.into_iter().map(DirectoryPerson::from).collect(),
            limit,
            offset,
            total,
        }
    }
}
