// SPDX-License-Identifier: LicenseRef-Proprietary
//! Route-owned admission checked after authentication and before command replay.
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use console_kernel_core::{KernelError, OrgId};
use console_platform_db::{
    DbError,
    settings_read::{SettingKey, SettingValue, resolve_in_tx},
    with_org_snapshot,
};
use sqlx::PgPool;

#[derive(Debug, Clone, Copy)]
pub enum TenantModule {
    Evaluation,
}

#[derive(Debug, thiserror::Error)]
enum PolicyReadError {
    #[error(transparent)]
    Database(#[from] DbError),
    #[error(transparent)]
    Setting(#[from] KernelError),
    #[error("the module setting has no boolean value")]
    InvalidSetting,
}

impl TenantModule {
    /// Read operator enrollment and the tenant's effective preference from the same snapshot.
    ///
    /// # Errors
    /// Returns an unavailable error when either authoritative source cannot be read.
    pub async fn enabled(self, pool: &PgPool, org: OrgId) -> Result<bool, KernelError> {
        let (module, key) = match self {
            Self::Evaluation => ("evaluation", SettingKey::ModuleEvaluationEnabled),
        };
        with_org_snapshot(pool, org, |tx| Box::pin(async move {
            let enrolled = sqlx::query_scalar::<_, bool>(
                "SELECT enabled FROM tenant_module_enrollments WHERE org_id=$1 AND module_key=$2 ORDER BY revision DESC LIMIT 1"
            ).bind(org.as_uuid()).bind(module).fetch_optional(tx.as_mut()).await.map_err(DbError::from)?;
            if enrolled != Some(true) {
                return Ok(false);
            }
            let settings = resolve_in_tx(tx.as_mut(), org, &[key], None, time::OffsetDateTime::now_utc()).await?;
            match settings.get(&key).and_then(|result| result.as_ref().ok()).map(|value| value.value) {
                Some(SettingValue::Bool(enabled)) => Ok(enabled),
                _ => Err(PolicyReadError::InvalidSetting),
            }
        })).await.map_err(|err| {
            tracing::error!(error = %err, "module policy read failed");
            KernelError::unavailable("module policy unavailable")
        })
    }

    pub(crate) async fn admit(self, pool: &PgPool, org: OrgId) -> Result<(), Response> {
        let (status, code, message) = match self.enabled(pool, org).await {
            Ok(true) => return Ok(()),
            Ok(false) => (
                StatusCode::FORBIDDEN,
                "module_disabled",
                "module is disabled for this tenant",
            ),
            Err(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "module policy unavailable",
            ),
        };
        Err((
            status,
            Json(serde_json::json!({"error": {"code": code, "message": message}})),
        )
            .into_response())
    }
}
