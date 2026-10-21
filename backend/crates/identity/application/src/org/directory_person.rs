//! The directory read of an account: its summary without the phone.

use serde::{Deserialize, Serialize};

use super::{DirectoryPerson, UserPage, UserSummary};

impl From<UserSummary> for DirectoryPerson {
    fn from(user: UserSummary) -> Self {
        let UserSummary {
            id,
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
