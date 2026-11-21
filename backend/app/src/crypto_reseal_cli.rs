// SPDX-License-Identifier: LicenseRef-Proprietary
//! One-shot CLI entrypoint for `console-app crypto-reseal`, `crypto-census`,
//! `rotate-tenant-dek`, and `rewrap-master-kek`.

use std::sync::Arc;
use std::time::Duration;

#[cfg(feature = "mail")]
use console_comms_application::CredentialCipher;
use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_hr_domain::import::rrn_value::RrnVault;
use console_platform_crypto::KmsProvider;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

#[path = "crypto_reseal_cli_args.rs"]
mod args;

use crate::config::secret_files::secret_env;
use crate::crypto_reseal::{execute_census, execute_reseal};
use crate::crypto_reseal_rotation::{execute_rewrap_master_kek, execute_rotate_tenant_dek};
use crate::error::AppError;
use crate::hr::rrn_vault::{self, EnvRrnVault};
use crate::state::db::serving::{
    reset_serving_database_connection, validate_database_connection_identity,
    validate_database_pool_identity,
};
use args::{CryptoCliCommand, parse_cli_command};

/// One-shot CLI entrypoint for crypto maintenance subcommands.
pub async fn run_crypto_cli(command: &str, args: &[String]) -> Result<(), AppError> {
    let parsed = parse_cli_command(command, args)?;
    let url = secret_env("DATABASE_URL")?
        .ok_or_else(|| AppError::Config(format!("{command} requires DATABASE_URL")))?;
    let pool = connect_runtime_maintenance_pool(&url).await?;

    let output = match parsed {
        CryptoCliCommand::Reseal {
            batch_size,
            max_batches,
        } => {
            let rrn_vault = load_rrn_vault(&pool)?;
            #[cfg(feature = "mail")]
            let mail_cipher = load_mail_cipher(&pool)?;
            let report = execute_reseal(
                &pool,
                rrn_vault,
                #[cfg(feature = "mail")]
                mail_cipher,
                batch_size,
                max_batches,
            )
            .await?;
            encode_json(&report)?
        }
        CryptoCliCommand::Census => {
            let rrn_vault = load_rrn_vault(&pool)?;
            #[cfg(feature = "mail")]
            let mail_cipher = load_mail_cipher(&pool)?;
            let report = execute_census(
                &pool,
                rrn_vault.as_deref(),
                #[cfg(feature = "mail")]
                mail_cipher.as_deref(),
            )
            .await?;
            encode_json(&report)?
        }
        CryptoCliCommand::RotateTenantDek { org_id, scope } => {
            let (rrn_kms, mail_kms) = load_master_kms_providers()?;
            let report = execute_rotate_tenant_dek(&pool, org_id, scope, rrn_kms, mail_kms).await?;
            encode_json(&report)?
        }
        CryptoCliCommand::RewrapMasterKek {
            org_id,
            scope,
            batch_size,
            max_batches,
        } => {
            let (rrn_kms, mail_kms) = load_master_kms_providers()?;
            let report = execute_rewrap_master_kek(
                &pool,
                org_id,
                scope,
                rrn_kms,
                mail_kms,
                batch_size,
                max_batches,
            )
            .await?;
            encode_json(&report)?
        }
    };
    pool.close().await;
    println!("{output}");
    Ok(())
}

fn encode_json<T: serde::Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value)
        .map_err(|err| AppError::Internal(format!("json encode failed: {err}")))
}

fn load_rrn_vault(pool: &PgPool) -> Result<Option<Arc<dyn RrnVault>>, AppError> {
    Ok(EnvRrnVault::from_env().map_err(AppError::Config)?.map(|v| {
        Arc::new(v.with_tenant_keys(
            pool.clone(),
            crate::rrn_vault_tenant::new_tenant_keys_from_env(),
        )) as Arc<dyn RrnVault>
    }))
}

#[cfg(feature = "mail")]
fn load_mail_cipher(pool: &PgPool) -> Result<Option<Arc<dyn CredentialCipher>>, AppError> {
    let keyring = secret_env(console_comms_credential_cipher::KEYRING_ENV)?;
    let master = secret_env(console_comms_credential_cipher::MASTER_KEY_ENV)?;
    Ok(
        EnvelopeCredentialCipher::from_owned_env_values(keyring, master)
            .map_err(|_| AppError::Config("invalid CONSOLE_MAIL_KEYRING/MASTER_KEY".to_owned()))?
            .map(|c| {
                Arc::new(crate::mail_cipher::TenantEnvMailCipher::new(
                    Arc::new(c),
                    pool.clone(),
                )) as Arc<dyn CredentialCipher>
            }),
    )
}

type MasterKmsPair = (Option<Arc<dyn KmsProvider>>, Option<Arc<dyn KmsProvider>>);

fn load_master_kms_providers() -> Result<MasterKmsPair, AppError> {
    let rrn_keyring = secret_env(rrn_vault::KEYRING_ENV)?;
    let rrn_master = secret_env(rrn_vault::MASTER_KEY_ENV)?;
    let rrn_kms = EnvelopeCredentialCipher::from_owned_env_values(rrn_keyring, rrn_master)
        .map_err(|_| AppError::Config("invalid CONSOLE_RRN_KEYRING/MASTER_KEY".to_owned()))?
        .map(|c| Arc::clone(c.kms_provider()));
    let mail_keyring = secret_env(console_comms_credential_cipher::KEYRING_ENV)?;
    let mail_master = secret_env(console_comms_credential_cipher::MASTER_KEY_ENV)?;
    let mail_kms = EnvelopeCredentialCipher::from_owned_env_values(mail_keyring, mail_master)
        .map_err(|_| AppError::Config("invalid CONSOLE_MAIL_KEYRING/MASTER_KEY".to_owned()))?
        .map(|c| Arc::clone(c.kms_provider()));
    Ok((rrn_kms, mail_kms))
}

async fn connect_runtime_maintenance_pool(url: &str) -> Result<PgPool, AppError> {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                validate_database_connection_identity(conn, "DATABASE_URL", "console_rt").await
            })
        })
        .after_release(|conn, _meta| {
            Box::pin(async move {
                reset_serving_database_connection(conn, "DATABASE_URL", "console_rt").await
            })
        })
        .connect(url)
        .await
        .map_err(AppError::Database)?;
    validate_database_pool_identity(&pool, "DATABASE_URL", "console_rt").await?;
    Ok(pool)
}
