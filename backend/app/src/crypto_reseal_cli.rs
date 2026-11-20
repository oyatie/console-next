// SPDX-License-Identifier: LicenseRef-Proprietary
//! One-shot CLI entrypoint for `console-app crypto-reseal` and `console-app crypto-census`.

use std::sync::Arc;
use std::time::Duration;

#[cfg(feature = "mail")]
use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_hr_domain::import::rrn_value::RrnVault;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use crate::config::secret_files::secret_env;
use crate::crypto_reseal::{execute_census, execute_reseal};
use crate::error::AppError;
use crate::hr::rrn_vault::EnvRrnVault;
use crate::state::db::serving::{
    reset_serving_database_connection, validate_database_connection_identity,
    validate_database_pool_identity,
};

const DEFAULT_BATCH_SIZE: i64 = 100;
const CLI_DEFAULT_MAX_BATCHES_PER_ORG: usize = 1_000;

/// One-shot CLI entrypoint for `console-app crypto-reseal` and `console-app crypto-census`.
pub async fn run_crypto_cli(command: &str, args: &[String]) -> Result<(), AppError> {
    let (batch_size, max_batches) = parse_cli_limits(args)?;
    let url = secret_env("DATABASE_URL")?
        .ok_or_else(|| AppError::Config(format!("{command} requires DATABASE_URL")))?;
    let pool = connect_runtime_maintenance_pool(&url).await?;
    let rrn_vault: Option<Arc<dyn RrnVault>> = EnvRrnVault::from_env()
        .map_err(AppError::Config)?
        .map(|v| Arc::new(v) as Arc<dyn RrnVault>);

    #[cfg(feature = "mail")]
    let mail_cipher: Option<Arc<EnvelopeCredentialCipher>> = {
        let keyring = secret_env(console_comms_credential_cipher::KEYRING_ENV)?;
        let master = secret_env(console_comms_credential_cipher::MASTER_KEY_ENV)?;
        EnvelopeCredentialCipher::from_owned_env_values(keyring, master)
            .map_err(|_| AppError::Config("invalid CONSOLE_MAIL_KEYRING/MASTER_KEY".to_owned()))?
            .map(Arc::new)
    };

    let output = match command {
        "crypto-reseal" => {
            let report = execute_reseal(
                &pool,
                rrn_vault,
                #[cfg(feature = "mail")]
                mail_cipher,
                batch_size,
                max_batches,
            )
            .await?;
            serde_json::to_string(&report)
                .map_err(|err| AppError::Internal(format!("json encode failed: {err}")))?
        }
        "crypto-census" => {
            let report = execute_census(
                &pool,
                rrn_vault.as_deref(),
                #[cfg(feature = "mail")]
                mail_cipher.as_deref(),
            )
            .await?;
            serde_json::to_string(&report)
                .map_err(|err| AppError::Internal(format!("json encode failed: {err}")))?
        }
        other => {
            return Err(AppError::Config(format!("unknown crypto command {other}")));
        }
    };
    pool.close().await;
    println!("{output}");
    Ok(())
}

fn parse_cli_limits(args: &[String]) -> Result<(i64, usize), AppError> {
    let mut batch_size = DEFAULT_BATCH_SIZE;
    let mut max_batches = CLI_DEFAULT_MAX_BATCHES_PER_ORG;
    let mut idx = 0;
    while idx < args.len() {
        match args[idx].as_str() {
            "--batch-size" => {
                let raw = args
                    .get(idx + 1)
                    .ok_or_else(|| AppError::Config("--batch-size requires a value".to_owned()))?;
                batch_size = raw
                    .parse::<i64>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| AppError::Config("invalid --batch-size".to_owned()))?;
                idx += 2;
            }
            "--max-batches" => {
                let raw = args
                    .get(idx + 1)
                    .ok_or_else(|| AppError::Config("--max-batches requires a value".to_owned()))?;
                max_batches = raw
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| AppError::Config("invalid --max-batches".to_owned()))?;
                idx += 2;
            }
            unknown => {
                return Err(AppError::Config(format!("unknown option {unknown}")));
            }
        }
    }
    Ok((batch_size, max_batches))
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
