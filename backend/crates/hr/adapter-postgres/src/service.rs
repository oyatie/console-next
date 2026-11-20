//! `HrService`: the facade the HR REST handlers call (backend-module-map
//! §1.3). Its methods live beside their subdomain, one `impl` per file.

use std::fmt;
use std::sync::Arc;

use console_hr_domain::import::rrn_value::RrnVault;
use sqlx::PgPool;

#[derive(Clone)]
pub struct HrService {
    pub(crate) pool: PgPool,
    pub(crate) rrn_vault: Option<Arc<dyn RrnVault>>,
}

impl fmt::Debug for HrService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HrService")
            .field("has_rrn_vault", &self.rrn_vault.is_some())
            .finish_non_exhaustive()
    }
}

impl HrService {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            rrn_vault: None,
        }
    }

    #[must_use]
    pub fn with_rrn_vault(mut self, rrn_vault: Option<Arc<dyn RrnVault>>) -> Self {
        self.rrn_vault = rrn_vault;
        self
    }
}
