//! `HrService`: the facade the HR REST handlers call (backend-module-map
//! §1.3). Its methods live beside their subdomain, one `impl` per file.

use sqlx::PgPool;

#[derive(Debug, Clone)]
pub struct HrService {
    pub(crate) pool: PgPool,
}

impl HrService {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}
