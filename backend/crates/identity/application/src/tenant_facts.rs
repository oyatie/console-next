// SPDX-License-Identifier: LicenseRef-Proprietary
//! The caller's tenant identity, independent of directory permissions.
use std::{future::Future, pin::Pin};

use console_kernel_core::{KernelError, OrgId, TenantPhase};
use serde::Serialize;
use time::OffsetDateTime;

use crate::UserSummary;

#[derive(Debug, Serialize)]
pub struct CurrentUser {
    #[serde(flatten)]
    pub user: UserSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant: Option<UserTenant>,
}

#[derive(Debug, Serialize)]
pub struct UserTenant {
    pub name: String,
    pub phase: TenantPhase,
    #[serde(with = "time::serde::rfc3339::option")]
    pub go_live_at: Option<OffsetDateTime>,
}

pub trait TenantFactsRead: Send + Sync {
    fn read_tenant(
        &self,
        org: OrgId,
    ) -> Pin<Box<dyn Future<Output = Result<UserTenant, KernelError>> + Send + '_>>;
}
