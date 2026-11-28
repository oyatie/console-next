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
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TenantModule {
    Benefits,
    Calendar,
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
    fn policy(self) -> (&'static str, SettingKey) {
        match self {
            Self::Benefits => ("benefits", SettingKey::ModuleBenefitsEnabled),
            Self::Calendar => ("calendar", SettingKey::ModuleCalendarEnabled),
            Self::Evaluation => ("evaluation", SettingKey::ModuleEvaluationEnabled),
        }
    }

    /// Read operator enrollment and effective tenant preferences in one snapshot.
    /// An absent enrollment excludes the module even when its setting defaults to true.
    pub async fn enabled_modules(
        pool: &PgPool,
        org: OrgId,
        requested: Vec<Self>,
    ) -> Result<BTreeSet<Self>, KernelError> {
        if requested.is_empty() {
            return Ok(BTreeSet::new());
        }
        with_org_snapshot(pool, org, |tx| {
            Box::pin(async move {
                let names: Vec<_> = requested.iter().map(|module| module.policy().0).collect();
                let active = sqlx::query_scalar::<_, String>(
                    "SELECT module_key FROM (
                        SELECT DISTINCT ON (module_key) module_key, enabled
                        FROM tenant_module_enrollments
                        WHERE org_id=$1 AND module_key=ANY($2)
                        ORDER BY module_key, revision DESC
                    ) latest WHERE enabled",
                )
                .bind(org.as_uuid())
                .bind(names)
                .fetch_all(tx.as_mut())
                .await
                .map_err(DbError::from)?;
                let enrolled: Vec<_> = requested
                    .into_iter()
                    .filter(|module| active.iter().any(|name| name == module.policy().0))
                    .collect();
                let keys: Vec<_> = enrolled.iter().map(|module| module.policy().1).collect();
                let mut enabled = BTreeSet::new();
                if keys.is_empty() {
                    return Ok(enabled);
                }
                let settings = resolve_in_tx(
                    tx.as_mut(),
                    org,
                    &keys,
                    None,
                    time::OffsetDateTime::now_utc(),
                )
                .await?;
                for module in enrolled {
                    let setting = settings
                        .get(&module.policy().1)
                        .and_then(|result| result.as_ref().ok());
                    match setting.map(|resolved| resolved.value) {
                        Some(SettingValue::Bool(true)) => {
                            enabled.insert(module);
                        }
                        Some(SettingValue::Bool(false)) => {}
                        _ => return Err(PolicyReadError::InvalidSetting),
                    }
                }
                Ok(enabled)
            })
        })
        .await
        .map_err(|err| {
            tracing::error!(error = %err, "module policy read failed");
            KernelError::unavailable("module policy unavailable")
        })
    }

    /// Check current enrollment and preference for one feature router.
    pub async fn enabled(self, pool: &PgPool, org: OrgId) -> Result<bool, KernelError> {
        Ok(Self::enabled_modules(pool, org, vec![self])
            .await?
            .contains(&self))
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
