// SPDX-License-Identifier: LicenseRef-Proprietary
//! Worker-tick and one-shot orchestration for audited credential envelope
//! re-sealing (`v1`/`v2`/retired KEK -> active `v3`) and legacy census reporting.

use std::sync::Arc;

#[cfg(feature = "mail")]
use console_comms_adapter_postgres::{EmailEnvelopeCensus, EmailResealStats, PgMailStore};
#[cfg(feature = "mail")]
use console_comms_application::CredentialCipher;
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::rrn::census::RrnEnvelopeCensus;
use console_hr_adapter_postgres::rrn::reseal::RrnResealStats;
use console_hr_domain::import::rrn_value::RrnVault;
use serde::Serialize;
use sqlx::PgPool;

use crate::error::AppError;

const DEFAULT_BATCH_SIZE: i64 = 100;
const WORKER_MAX_BATCHES_PER_ORG: usize = 10;

/// Non-PII summary of one RRN envelope re-seal pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RrnResealReport {
    pub configured: bool,
    pub employee_rrn_updated: usize,
    pub staged_identities_updated: usize,
}

/// Non-PII summary of one webmail credential re-seal pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct EmailResealReport {
    pub configured: bool,
    pub accounts_updated: usize,
    pub smtp_resealed: usize,
    pub imap_resealed: usize,
}

/// Combined non-PII re-seal report printed as JSON by `crypto-reseal`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CryptoResealReport {
    pub rrn: RrnResealReport,
    pub email: Option<EmailResealReport>,
}

/// Non-PII per-table counts for a single envelope table/slot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TableCensusReport {
    pub v1: i64,
    pub v2: i64,
    pub v3_stale_kek: i64,
    pub v3_current: i64,
    pub other: i64,
}

/// Non-PII census across RRN tables.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RrnCensusReport {
    pub active_alg_id: Option<String>,
    pub active_kek_id: Option<String>,
    pub employee_rrn: TableCensusReport,
    pub data_import_row_identities: TableCensusReport,
}

/// Non-PII census across `email_accounts` SMTP and IMAP slots.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct EmailCensusReport {
    pub active_alg_id: String,
    pub active_kek_id: String,
    pub smtp: TableCensusReport,
    pub imap: TableCensusReport,
}

/// Combined non-PII census report printed as JSON by `crypto-census`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CryptoCensusReport {
    pub rrn: Option<RrnCensusReport>,
    pub email: Option<EmailCensusReport>,
}

/// Worker-role scheduled tick (non-fatal per module; retries next tick).
pub(crate) async fn run_worker_tick(
    pool: &PgPool,
    rrn_vault: Option<Arc<dyn RrnVault>>,
    #[cfg(feature = "mail")] mail_cipher: Option<Arc<dyn CredentialCipher>>,
) {
    if let Some(vault) = rrn_vault {
        match HrService::new(pool.clone())
            .reseal_rrn_envelopes_with_limits(vault, DEFAULT_BATCH_SIZE, WORKER_MAX_BATCHES_PER_ORG)
            .await
        {
            Ok(stats) if stats.total_updated() == 0 => {}
            Ok(stats) => tracing::info!(
                employee_rrn = stats.employee_rrn_updated,
                staged_identities = stats.staged_identities_updated,
                "RRN envelopes re-sealed"
            ),
            Err(error) => tracing::warn!(
                error = %error.message,
                "RRN envelope re-seal pass failed"
            ),
        }
    }
    #[cfg(feature = "mail")]
    if let Some(cipher) = mail_cipher {
        match PgMailStore::new(pool.clone())
            .reseal_email_accounts(cipher, DEFAULT_BATCH_SIZE, WORKER_MAX_BATCHES_PER_ORG)
            .await
        {
            Ok(stats) if stats.accounts_updated == 0 => {}
            Ok(stats) => tracing::info!(
                accounts = stats.accounts_updated,
                smtp = stats.smtp_resealed,
                imap = stats.imap_resealed,
                "email account credentials re-sealed"
            ),
            Err(error) => tracing::warn!(
                error = %error,
                "email account credential re-seal pass failed"
            ),
        }
    }
}

/// Execute batched re-sealing across configured RRN and webmail tables.
pub async fn execute_reseal(
    pool: &PgPool,
    rrn_vault: Option<Arc<dyn RrnVault>>,
    #[cfg(feature = "mail")] mail_cipher: Option<Arc<dyn CredentialCipher>>,
    batch_size: i64,
    max_batches: usize,
) -> Result<CryptoResealReport, AppError> {
    let rrn = if let Some(vault) = rrn_vault {
        let stats: RrnResealStats = HrService::new(pool.clone())
            .reseal_rrn_envelopes_with_limits(vault, batch_size, max_batches)
            .await
            .map_err(|err| AppError::Internal(err.message))?;
        RrnResealReport {
            configured: true,
            employee_rrn_updated: stats.employee_rrn_updated,
            staged_identities_updated: stats.staged_identities_updated,
        }
    } else {
        RrnResealReport::default()
    };

    #[cfg(feature = "mail")]
    let email = if let Some(cipher) = mail_cipher {
        let stats: EmailResealStats = PgMailStore::new(pool.clone())
            .reseal_email_accounts(cipher, batch_size, max_batches)
            .await
            .map_err(|err| AppError::Internal(err.to_string()))?;
        Some(EmailResealReport {
            configured: true,
            accounts_updated: stats.accounts_updated,
            smtp_resealed: stats.smtp_resealed,
            imap_resealed: stats.imap_resealed,
        })
    } else {
        Some(EmailResealReport::default())
    };
    #[cfg(not(feature = "mail"))]
    let email = None;

    Ok(CryptoResealReport { rrn, email })
}

/// Execute legacy/stale-KEK census across configured RRN and webmail tables.
pub async fn execute_census(
    pool: &PgPool,
    rrn_vault: Option<&dyn RrnVault>,
    #[cfg(feature = "mail")] mail_cipher: Option<&dyn CredentialCipher>,
) -> Result<CryptoCensusReport, AppError> {
    let rrn = if let Some(vault) = rrn_vault
        && let (Some(alg), Some(kek)) = (vault.active_alg_id(), vault.active_kek_id())
    {
        let census: RrnEnvelopeCensus = HrService::new(pool.clone())
            .legacy_envelope_census_with_vault(vault)
            .await
            .map_err(|err| AppError::Internal(err.message))?;
        Some(RrnCensusReport {
            active_alg_id: Some(alg.to_owned()),
            active_kek_id: Some(kek.to_owned()),
            employee_rrn: TableCensusReport {
                v1: census.employee_rrn.v1,
                v2: census.employee_rrn.v2,
                v3_stale_kek: census.employee_rrn.v3_stale_kek,
                v3_current: census.employee_rrn.v3_current,
                other: census.employee_rrn.other,
            },
            data_import_row_identities: TableCensusReport {
                v1: census.data_import_row_identities.v1,
                v2: census.data_import_row_identities.v2,
                v3_stale_kek: census.data_import_row_identities.v3_stale_kek,
                v3_current: census.data_import_row_identities.v3_current,
                other: census.data_import_row_identities.other,
            },
        })
    } else {
        None
    };

    #[cfg(feature = "mail")]
    let email = if let Some(cipher) = mail_cipher {
        let alg = cipher.active_alg_id().unwrap_or_default();
        let kek = cipher.active_kek_id().unwrap_or_default();
        let census: EmailEnvelopeCensus = PgMailStore::new(pool.clone())
            .legacy_envelope_census_with_cipher(cipher)
            .await
            .map_err(|err| AppError::Internal(err.to_string()))?;
        Some(EmailCensusReport {
            active_alg_id: alg.to_owned(),
            active_kek_id: kek.to_owned(),
            smtp: TableCensusReport {
                v1: census.smtp.v1,
                v2: census.smtp.v2,
                v3_stale_kek: census.smtp.v3_stale_kek,
                v3_current: census.smtp.v3_current,
                other: census.smtp.other,
            },
            imap: TableCensusReport {
                v1: census.imap.v1,
                v2: census.imap.v2,
                v3_stale_kek: census.imap.v3_stale_kek,
                v3_current: census.imap.v3_current,
                other: census.imap.other,
            },
        })
    } else {
        None
    };
    #[cfg(not(feature = "mail"))]
    let email = None;

    Ok(CryptoCensusReport { rrn, email })
}
