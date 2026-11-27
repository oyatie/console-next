// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant roles, grants and effective access — the use cases and their store
//! (decision #26 pilot roles slice; access-model AX-6 subset). The REST face
//! is `console-platform-access-rest`.
//!
//! Every check is a Cedar decision over the caller's own grants
//! ([`console_platform_authz::access`]): access management view / edit over the
//! whole tenant or over a grant's scope, and the grantor ceiling (GR-7). The
//! ops account passes by the platform policy. Nothing here names a role.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod access_review;
mod actor;
pub mod caveats;
mod dto;
pub mod effective;
mod error;
mod grant_ops;
mod grant_types;
pub mod grants;
mod grants_store;
pub mod invites;
pub mod log_review;
pub mod notice;
pub mod ops_holders;
pub mod pending;
pub mod requests;
mod role_requests;
pub mod roles;
mod roles_store;

pub use dto::{GrantOut, LineIn, LineOut, RoleOut, ScopeIn, ScopeOut, StepUp};
pub use error::{AccessError, AccessResult, Refusal};

use console_platform_auth::PasskeyService;
use console_platform_provisioning::BootstrapCredentialStore;
use sqlx::PgPool;

/// What the use cases run on.
#[derive(Clone)]
pub struct AccessService {
    pool: PgPool,
    /// Verifies the passkey step-up that granting access needs. `None` refuses it.
    step_up: Option<PasskeyService>,
    /// Issues first-sign-in bootstrap OTPs inside atomic invite transactions.
    bootstrap: BootstrapCredentialStore,
}

impl AccessService {
    #[must_use]
    pub fn new(pool: PgPool, step_up: Option<PasskeyService>) -> Self {
        #[cfg(debug_assertions)]
        let bootstrap = BootstrapCredentialStore::default();
        #[cfg(not(debug_assertions))]
        let bootstrap = BootstrapCredentialStore::unconfigured();
        Self {
            pool,
            step_up,
            bootstrap,
        }
    }

    #[must_use]
    pub fn with_bootstrap_credentials(mut self, bootstrap: BootstrapCredentialStore) -> Self {
        self.bootstrap = bootstrap;
        self
    }

    #[must_use]
    pub const fn pool(&self) -> &PgPool {
        &self.pool
    }
}
