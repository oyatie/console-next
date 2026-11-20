// SPDX-License-Identifier: LicenseRef-Proprietary
//! One-shot CLI entrypoint for `console-app crypto-reseal` and `console-app crypto-census`.

use std::sync::Arc;
use std::time::Duration;

#[cfg(feature = "mail")]
use console_comms_application::CredentialCipher;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CryptoCliCommand {
    Reseal { batch_size: i64, max_batches: usize },
    Census,
}

/// One-shot CLI entrypoint for `console-app crypto-reseal` and `console-app crypto-census`.
pub async fn run_crypto_cli(command: &str, args: &[String]) -> Result<(), AppError> {
    let parsed = parse_cli_command(command, args)?;
    let url = secret_env("DATABASE_URL")?
        .ok_or_else(|| AppError::Config(format!("{command} requires DATABASE_URL")))?;
    let pool = connect_runtime_maintenance_pool(&url).await?;
    let rrn_vault: Option<Arc<dyn RrnVault>> =
        EnvRrnVault::from_env().map_err(AppError::Config)?.map(|v| {
            Arc::new(v.with_tenant_keys(
                pool.clone(),
                crate::rrn_vault_tenant::new_tenant_keys_from_env(),
            )) as Arc<dyn RrnVault>
        });

    #[cfg(feature = "mail")]
    let mail_cipher: Option<Arc<dyn CredentialCipher>> = {
        let keyring = secret_env(console_comms_credential_cipher::KEYRING_ENV)?;
        let master = secret_env(console_comms_credential_cipher::MASTER_KEY_ENV)?;
        EnvelopeCredentialCipher::from_owned_env_values(keyring, master)
            .map_err(|_| AppError::Config("invalid CONSOLE_MAIL_KEYRING/MASTER_KEY".to_owned()))?
            .map(|c| {
                Arc::new(crate::mail_cipher::TenantEnvMailCipher::new(
                    Arc::new(c),
                    pool.clone(),
                )) as Arc<dyn CredentialCipher>
            })
    };

    let output = match parsed {
        CryptoCliCommand::Reseal {
            batch_size,
            max_batches,
        } => {
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
        CryptoCliCommand::Census => {
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
    };
    pool.close().await;
    println!("{output}");
    Ok(())
}

fn parse_cli_command(command: &str, args: &[String]) -> Result<CryptoCliCommand, AppError> {
    match command {
        "crypto-reseal" => {
            let (batch_size, max_batches) = parse_cli_limits(args)?;
            Ok(CryptoCliCommand::Reseal {
                batch_size,
                max_batches,
            })
        }
        "crypto-census" => {
            if let Some(unexpected) = args.first() {
                return Err(AppError::Config(format!(
                    "crypto-census does not accept arguments (unexpected {unexpected})"
                )));
            }
            Ok(CryptoCliCommand::Census)
        }
        other => Err(AppError::Config(format!("unknown crypto command {other}"))),
    }
}

fn parse_positive_i64(flag: &str, raw: &str) -> Result<i64, AppError> {
    raw.parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| AppError::Config(format!("invalid {flag}")))
}

fn parse_positive_usize(flag: &str, raw: &str) -> Result<usize, AppError> {
    raw.parse::<usize>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| AppError::Config(format!("invalid {flag}")))
}

fn parse_cli_limits(args: &[String]) -> Result<(i64, usize), AppError> {
    let mut batch_size = DEFAULT_BATCH_SIZE;
    let mut max_batches = CLI_DEFAULT_MAX_BATCHES_PER_ORG;
    let mut idx = 0;
    while idx < args.len() {
        let arg = args[idx].as_str();
        if let Some(raw) = arg.strip_prefix("--batch-size=") {
            if raw.is_empty() {
                return Err(AppError::Config("--batch-size requires a value".to_owned()));
            }
            batch_size = parse_positive_i64("--batch-size", raw)?;
            idx += 1;
        } else if arg == "--batch-size" {
            let raw = args
                .get(idx + 1)
                .ok_or_else(|| AppError::Config("--batch-size requires a value".to_owned()))?;
            batch_size = parse_positive_i64("--batch-size", raw)?;
            idx += 2;
        } else if let Some(raw) = arg.strip_prefix("--max-batches=") {
            if raw.is_empty() {
                return Err(AppError::Config(
                    "--max-batches requires a value".to_owned(),
                ));
            }
            max_batches = parse_positive_usize("--max-batches", raw)?;
            idx += 1;
        } else if arg == "--max-batches" {
            let raw = args
                .get(idx + 1)
                .ok_or_else(|| AppError::Config("--max-batches requires a value".to_owned()))?;
            max_batches = parse_positive_usize("--max-batches", raw)?;
            idx += 2;
        } else {
            return Err(AppError::Config(format!("unknown option {arg}")));
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

#[cfg(test)]
mod tests {
    use super::{
        CLI_DEFAULT_MAX_BATCHES_PER_ORG, CryptoCliCommand, DEFAULT_BATCH_SIZE, parse_cli_command,
        parse_cli_limits,
    };
    use crate::error::AppError;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn parse_cli_limits_uses_defaults_when_no_flags_supplied() {
        assert_eq!(
            parse_cli_limits(&[]).unwrap(),
            (DEFAULT_BATCH_SIZE, CLI_DEFAULT_MAX_BATCHES_PER_ORG)
        );
    }

    #[test]
    fn parse_cli_limits_accepts_space_and_equals_flags() {
        assert_eq!(
            parse_cli_limits(&args(&["--batch-size", "25", "--max-batches", "7"])).unwrap(),
            (25, 7)
        );
        assert_eq!(
            parse_cli_limits(&args(&["--batch-size=50", "--max-batches=12"])).unwrap(),
            (50, 12)
        );
        assert_eq!(
            parse_cli_limits(&args(&["--batch-size", "1", "--max-batches=3"])).unwrap(),
            (1, 3)
        );
    }

    #[test]
    fn parse_cli_limits_rejects_invalid_and_unknown_flags() {
        for case in [
            vec!["--batch-size", "0"],
            vec!["--batch-size=0"],
            vec!["--max-batches", "0"],
            vec!["--max-batches=0"],
            vec!["--batch-size", "-5"],
            vec!["--batch-size=-5"],
            vec!["--max-batches", "-1"],
            vec!["--max-batches=-1"],
            vec!["--batch-size", "abc"],
            vec!["--batch-size=abc"],
            vec!["--max-batches", "xyz"],
            vec!["--max-batches=xyz"],
            vec!["--batch-size"],
            vec!["--batch-size="],
            vec!["--max-batches"],
            vec!["--max-batches="],
            vec!["--batch-size", "--max-batches", "5"],
            vec!["--unknown"],
            vec!["--unknown=1"],
            vec!["positional"],
        ] {
            let err = parse_cli_limits(&args(&case)).unwrap_err();
            assert!(
                matches!(err, AppError::Config(_)),
                "expected Config error for {case:?}, got {err:?}"
            );
        }
    }

    #[test]
    fn parse_cli_command_validates_command_specific_args() {
        assert_eq!(
            parse_cli_command("crypto-reseal", &[]).unwrap(),
            CryptoCliCommand::Reseal {
                batch_size: DEFAULT_BATCH_SIZE,
                max_batches: CLI_DEFAULT_MAX_BATCHES_PER_ORG,
            }
        );
        assert_eq!(
            parse_cli_command(
                "crypto-reseal",
                &args(&["--batch-size=20", "--max-batches", "4"])
            )
            .unwrap(),
            CryptoCliCommand::Reseal {
                batch_size: 20,
                max_batches: 4,
            }
        );
        assert_eq!(
            parse_cli_command("crypto-census", &[]).unwrap(),
            CryptoCliCommand::Census
        );
        for rejected in [
            vec!["--batch-size", "10"],
            vec!["--batch-size=10"],
            vec!["--max-batches", "2"],
            vec!["--max-batches=2"],
            vec!["--unknown"],
        ] {
            let err = parse_cli_command("crypto-census", &args(&rejected)).unwrap_err();
            assert!(
                matches!(err, AppError::Config(_)),
                "expected crypto-census to reject {rejected:?}, got {err:?}"
            );
        }
        assert!(matches!(
            parse_cli_command("crypto-unknown", &[]).unwrap_err(),
            AppError::Config(_)
        ));
    }
}
