use crate::error::RestError;
use console_kernel_core::OrgId;
use console_platform_db::DbError;
use uuid::Uuid;

// Bound handoff operations share the Account-first order. Unbound start remains
// independent. Callers must finish this transaction before invoking pool owners.
pub(crate) async fn lock_handoff_account_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    user: Uuid,
) -> Result<(), RestError> {
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .map_err(DbError::Sqlx)?;
    if console_platform_auth::lock_account_tx(tx, org, user)
        .await
        .map_err(DbError::Sqlx)?
        != Some(true)
    {
        return Err(RestError::unauthorized("inactive or missing Account"));
    }
    Ok(())
}

pub(crate) async fn ensure_handoff_company_active_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
) -> Result<(), RestError> {
    if org != OrgId::platform() {
        let active: Option<bool> =
            sqlx::query_scalar("SELECT status='ACTIVE' FROM organizations WHERE id=$1")
                .bind(*org.as_uuid())
                .fetch_optional(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
        if active != Some(true) {
            return Err(RestError::unauthorized("inactive Company"));
        }
    }
    Ok(())
}

pub(crate) async fn lock_handoff_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> Result<sqlx::postgres::PgRow, RestError> {
    sqlx::query("SELECT * FROM auth_device_login_handoffs WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await
        .map_err(DbError::Sqlx)?
        .ok_or_else(|| RestError::unauthorized("invalid or expired login handoff"))
}
