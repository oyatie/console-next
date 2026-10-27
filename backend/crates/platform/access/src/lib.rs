//! Tenant roles, grants and effective access — the use cases and their store
//! (decision #26 pilot roles slice; access-model AX-6 subset). The REST face
//! is `console-platform-access-rest`.
//!
//! Every check is a Cedar decision over the caller's own grants
//! ([`console_platform_authz::access`]): 권한 관리 조회 / 등록·수정 over the
//! whole tenant or over a grant's scope, and the grantor ceiling (GR-7). The
//! ops account passes by the platform policy. Nothing here names a role.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod actor;
pub mod caveats;
mod dto;
pub mod effective;
mod error;
mod grant_ops;
mod grant_types;
pub mod grants;
mod grants_store;
pub mod log_review;
pub mod notice;
pub mod pending;
pub mod requests;
mod role_requests;
pub mod roles;
mod roles_store;

pub use dto::{GrantOut, LineIn, LineOut, RoleOut, ScopeIn, ScopeOut, StepUp};
pub use error::{AccessError, AccessResult, Refusal};

use console_platform_auth::PasskeyService;
use sqlx::PgPool;

/// What the use cases run on.
#[derive(Clone)]
pub struct AccessService {
    pool: PgPool,
    /// Verifies the passkey step-up 권한 부여 needs. `None` refuses it.
    step_up: Option<PasskeyService>,
}

impl AccessService {
    #[must_use]
    pub const fn new(pool: PgPool, step_up: Option<PasskeyService>) -> Self {
        Self { pool, step_up }
    }

    #[must_use]
    pub const fn pool(&self) -> &PgPool {
        &self.pool
    }
}
