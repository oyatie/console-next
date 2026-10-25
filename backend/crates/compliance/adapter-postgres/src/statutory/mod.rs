//! Reads the validated migration-owned statutory register.
use crate::{PgComplianceError, PgComplianceStore};
use console_compliance_domain::statutory::StatutoryRegister;
use sqlx::PgConnection;

impl PgComplianceStore {
    pub async fn statutory_register(&self) -> Result<StatutoryRegister, PgComplianceError> {
        let mut conn = self.pool().acquire().await?;
        load_statutory_register(&mut conn).await
    }
}

pub async fn load_statutory_register(
    conn: &mut PgConnection,
) -> Result<StatutoryRegister, PgComplianceError> {
    Ok(console_platform_db::statutory_read::load_statutory_register(conn).await?)
}
