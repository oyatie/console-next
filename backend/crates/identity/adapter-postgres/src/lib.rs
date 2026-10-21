//! Postgres adapter for the identity/org-setup domain.
//!
//! Every mutation routes through `with_audit`/`with_audits` so an `audit_events`
//! row lands in the SAME transaction as the state change (audit-coverage gate).
//! User reads are branch-scoped: `BranchScope::All` (SUPER_ADMIN/EXECUTIVE) sees
//! every user; a branch-scoped caller sees only users sharing an in-scope branch.
//! User branch *writes* (`replace_user_branches`) also fail closed on the actor's
//! live BranchScope (union of current + requested memberships) so a non-REST
//! caller cannot strip or mint out-of-scope memberships (console-o498).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod error;
mod org_structure;
mod policy;
pub mod second_person;
mod users;

pub use error::PgOrgError;
pub use users::sign_in_id;

use sqlx::PgPool;

/// Outcome of an `Idempotency-Key`-guarded create: the stored response body.
#[derive(Debug)]
pub enum IdempotentCreate {
    /// First use of the key: the resource was created (HTTP 201).
    Created(serde_json::Value),
    /// Exact replay of a completed key: the committed response (HTTP 200).
    Replay(serde_json::Value),
}

#[derive(Debug, Clone)]
pub struct PgOrgStore {
    pool: PgPool,
}

impl PgOrgStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}
