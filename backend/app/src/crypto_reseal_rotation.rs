// SPDX-License-Identifier: LicenseRef-Proprietary
//! One-shot CLI orchestration for per-tenant DEK rotation (`rotate-tenant-dek`)
//! and master KEK re-wrapping (`rewrap-master-kek`).

use std::sync::Arc;

use console_kernel_core::OrgId;
use console_platform_crypto::{KmsProvider, TenantDekMode, TenantKeyScope};
use console_platform_db::tenant_keys::PgTenantKeyStore;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;

/// Scope selector for `rotate-tenant-dek` and `rewrap-master-kek`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoScopeSelection {
    Rrn,
    Mail,
    All,
}

impl CryptoScopeSelection {
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "rrn" => Ok(Self::Rrn),
            "mail" => Ok(Self::Mail),
            "all" => Ok(Self::All),
            _ => Err(AppError::Config(format!(
                "invalid --scope {raw:?} (expected rrn, mail, or all)"
            ))),
        }
    }

    pub const fn includes_rrn(self) -> bool {
        matches!(self, Self::Rrn | Self::All)
    }

    pub const fn includes_mail(self) -> bool {
        matches!(self, Self::Mail | Self::All)
    }
}

/// Non-PII summary emitted by `console-app rotate-tenant-dek`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RotateTenantDekReport {
    pub org_id: Uuid,
    pub rrn_version: Option<i32>,
    pub mail_version: Option<i32>,
}

/// Non-PII summary emitted by `console-app rewrap-master-kek`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RewrapMasterKekReport {
    pub orgs_scanned: usize,
    pub rrn_keys_rewrapped: usize,
    pub mail_keys_rewrapped: usize,
}

pub(crate) fn tenant_dek_mode_from_env() -> TenantDekMode {
    match TenantDekMode::from_env() {
        Ok(mode) => mode,
        Err(_) => {
            tracing::warn!("invalid CONSOLE_TENANT_DEK_MODE value; defaulting to active");
            TenantDekMode::Active
        }
    }
}

fn validate_scope_providers(
    scope: CryptoScopeSelection,
    rrn_kms: Option<&Arc<dyn KmsProvider>>,
    mail_kms: Option<&Arc<dyn KmsProvider>>,
) -> Result<(), AppError> {
    if scope == CryptoScopeSelection::Rrn && rrn_kms.is_none() {
        return Err(AppError::Config(
            "CONSOLE_RRN_KEYRING or CONSOLE_RRN_MASTER_KEY is required for --scope rrn".to_owned(),
        ));
    }
    if scope == CryptoScopeSelection::Mail && mail_kms.is_none() {
        return Err(AppError::Config(
            "CONSOLE_MAIL_KEYRING or CONSOLE_MAIL_MASTER_KEY is required for --scope mail"
                .to_owned(),
        ));
    }
    if scope == CryptoScopeSelection::All && rrn_kms.is_none() && mail_kms.is_none() {
        return Err(AppError::Config(
            "configure RRN and/or MAIL keyring/master key env vars".to_owned(),
        ));
    }
    Ok(())
}

/// Rotate the active per-tenant DEK for `org_id` across the selected scope(s).
pub async fn execute_rotate_tenant_dek(
    pool: &PgPool,
    org_id: Uuid,
    scope: CryptoScopeSelection,
    rrn_kms: Option<Arc<dyn KmsProvider>>,
    mail_kms: Option<Arc<dyn KmsProvider>>,
) -> Result<RotateTenantDekReport, AppError> {
    validate_scope_providers(scope, rrn_kms.as_ref(), mail_kms.as_ref())?;
    let store = PgTenantKeyStore::new(tenant_dek_mode_from_env());
    let org = OrgId::from_uuid(org_id);
    let rrn_version = if scope.includes_rrn()
        && let Some(kms) = rrn_kms
    {
        Some(
            store
                .rotate_tenant_dek(pool, org, TenantKeyScope::Rrn, kms, None)
                .await
                .map_err(|err| AppError::Internal(err.to_string()))?,
        )
    } else {
        None
    };
    let mail_version = if scope.includes_mail()
        && let Some(kms) = mail_kms
    {
        Some(
            store
                .rotate_tenant_dek(pool, org, TenantKeyScope::Mail, kms, None)
                .await
                .map_err(|err| AppError::Internal(err.to_string()))?,
        )
    } else {
        None
    };
    Ok(RotateTenantDekReport {
        org_id,
        rrn_version,
        mail_version,
    })
}

/// Re-wrap `tenant_encryption_keys` rows onto each scope's active master KEK.
pub async fn execute_rewrap_master_kek(
    pool: &PgPool,
    org_filter: Option<Uuid>,
    scope: CryptoScopeSelection,
    rrn_kms: Option<Arc<dyn KmsProvider>>,
    mail_kms: Option<Arc<dyn KmsProvider>>,
    batch_size: i64,
    max_batches: usize,
) -> Result<RewrapMasterKekReport, AppError> {
    validate_scope_providers(scope, rrn_kms.as_ref(), mail_kms.as_ref())?;
    let store = PgTenantKeyStore::new(tenant_dek_mode_from_env());
    let orgs: Vec<Uuid> = match org_filter {
        Some(org_id) => vec![org_id],
        None => sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org rewrap below runs under with_audits
            .fetch_all(pool)
            .await
            .map_err(AppError::Database)?,
    };

    let mut report = RewrapMasterKekReport {
        orgs_scanned: orgs.len(),
        ..Default::default()
    };
    for org_uuid in orgs {
        let org = OrgId::from_uuid(org_uuid);
        if scope.includes_rrn()
            && let Some(kms) = rrn_kms.as_ref()
        {
            report.rrn_keys_rewrapped += rewrap_org_scope(
                &store,
                pool,
                org,
                TenantKeyScope::Rrn,
                kms,
                batch_size,
                max_batches,
            )
            .await?;
        }
        if scope.includes_mail()
            && let Some(kms) = mail_kms.as_ref()
        {
            report.mail_keys_rewrapped += rewrap_org_scope(
                &store,
                pool,
                org,
                TenantKeyScope::Mail,
                kms,
                batch_size,
                max_batches,
            )
            .await?;
        }
    }
    Ok(report)
}

async fn rewrap_org_scope(
    store: &PgTenantKeyStore,
    pool: &PgPool,
    org: OrgId,
    scope: TenantKeyScope,
    kms: &Arc<dyn KmsProvider>,
    batch_size: i64,
    max_batches: usize,
) -> Result<usize, AppError> {
    let mut total = 0usize;
    for _ in 0..max_batches {
        let updated = store
            .rewrap_master_kek_scope_batch(pool, org, scope, Arc::clone(kms), batch_size)
            .await
            .map_err(|err| AppError::Internal(err.to_string()))?;
        total += updated;
        if updated == 0 {
            break;
        }
    }
    Ok(total)
}
