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

impl TenantModule {
    pub async fn enabled(self, pool: &PgPool, org: OrgId) -> Result<bool, KernelError> {
        let (enrollment, key) = match self {
            Self::Evaluation => ("evaluation", SettingKey::ModuleEvaluationEnabled),
        };
        with_org_snapshot(pool, org, |tx| {
            Box::pin(async move {
                let enrolled: bool = sqlx::query_scalar("SELECT enabled FROM tenant_module_enrollments WHERE org_id=$1 AND module_key=$2 ORDER BY revision DESC LIMIT 1")
                    .bind(org.as_uuid()).bind(enrollment)
                    .fetch_optional(tx.as_mut()).await?.unwrap_or(false);
                if !enrolled {
                    return Ok::<_, DbError>(Ok(false));
                }
                let values = resolve_in_tx(
                    tx.as_mut(),
                    org,
                    &[key],
                    None,
                    time::OffsetDateTime::now_utc(),
                )
                .await;
                Ok(values.and_then(|values| {
                    match values
                        .get(&key)
                        .and_then(|value| value.as_ref().ok())
                        .map(|v| v.value)
                    {
                        Some(SettingValue::Bool(enabled)) => Ok(enabled),
                        _ => Err(KernelError::unavailable("module policy unavailable")),
                    }
                }))
            })
        })
        .await
        .map_err(|err| {
            tracing::error!(error = %err, "module enrollment unavailable");
            KernelError::unavailable("module policy unavailable")
        })?
        .map_err(|_| KernelError::unavailable("module policy unavailable"))
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
