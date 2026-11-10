// SPDX-License-Identifier: LicenseRef-Proprietary
use sqlx::PgPool;

#[derive(Debug, Clone)]
pub struct PgComplianceStore {
    pub(super) pool: PgPool,
}

impl PgComplianceStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}
