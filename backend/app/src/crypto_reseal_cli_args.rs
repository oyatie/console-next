// SPDX-License-Identifier: LicenseRef-Proprietary
//! CLI flag parsing for `crypto-reseal`, `crypto-census`,
//! `rotate-tenant-dek`, and `rewrap-master-kek`.

use uuid::Uuid;

use crate::crypto_reseal_rotation::CryptoScopeSelection;
use crate::error::AppError;

pub(crate) const DEFAULT_BATCH_SIZE: i64 = 100;
pub(crate) const CLI_DEFAULT_MAX_BATCHES_PER_ORG: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CryptoCliCommand {
    Reseal {
        batch_size: i64,
        max_batches: usize,
    },
    Census,
    RotateTenantDek {
        org_id: Uuid,
        scope: CryptoScopeSelection,
    },
    RewrapMasterKek {
        org_id: Option<Uuid>,
        scope: CryptoScopeSelection,
        batch_size: i64,
        max_batches: usize,
    },
}

pub(crate) fn parse_cli_command(
    command: &str,
    args: &[String],
) -> Result<CryptoCliCommand, AppError> {
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
        "rotate-tenant-dek" => parse_rotate_tenant_dek_args(args),
        "rewrap-master-kek" => parse_rewrap_master_kek_args(args),
        other => Err(AppError::Config(format!("unknown crypto command {other}"))),
    }
}

fn next_flag_value<'a>(
    args: &'a [String],
    idx: &mut usize,
    flag: &str,
) -> Result<&'a str, AppError> {
    let arg = args[*idx].as_str();
    if let Some(raw) = arg.strip_prefix(&format!("{flag}=")) {
        if raw.is_empty() {
            return Err(AppError::Config(format!("{flag} requires a value")));
        }
        *idx += 1;
        Ok(raw)
    } else {
        let raw = args
            .get(*idx + 1)
            .ok_or_else(|| AppError::Config(format!("{flag} requires a value")))?;
        *idx += 2;
        Ok(raw.as_str())
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

fn parse_org_uuid(raw: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(raw).map_err(|_| AppError::Config(format!("invalid --org UUID {raw:?}")))
}

pub(crate) fn parse_cli_limits(args: &[String]) -> Result<(i64, usize), AppError> {
    let mut batch_size = DEFAULT_BATCH_SIZE;
    let mut max_batches = CLI_DEFAULT_MAX_BATCHES_PER_ORG;
    let mut idx = 0;
    while idx < args.len() {
        let arg = args[idx].as_str();
        if arg == "--batch-size" || arg.starts_with("--batch-size=") {
            batch_size = parse_positive_i64(
                "--batch-size",
                next_flag_value(args, &mut idx, "--batch-size")?,
            )?;
        } else if arg == "--max-batches" || arg.starts_with("--max-batches=") {
            max_batches = parse_positive_usize(
                "--max-batches",
                next_flag_value(args, &mut idx, "--max-batches")?,
            )?;
        } else {
            return Err(AppError::Config(format!("unknown option {arg}")));
        }
    }
    Ok((batch_size, max_batches))
}

fn parse_rotate_tenant_dek_args(args: &[String]) -> Result<CryptoCliCommand, AppError> {
    let mut org_id: Option<Uuid> = None;
    let mut scope: Option<CryptoScopeSelection> = None;
    let mut idx = 0;
    while idx < args.len() {
        let arg = args[idx].as_str();
        if arg == "--org" || arg.starts_with("--org=") {
            if org_id.is_some() {
                return Err(AppError::Config("duplicate --org option".to_owned()));
            }
            org_id = Some(parse_org_uuid(next_flag_value(args, &mut idx, "--org")?)?);
        } else if arg == "--scope" || arg.starts_with("--scope=") {
            if scope.is_some() {
                return Err(AppError::Config("duplicate --scope option".to_owned()));
            }
            scope = Some(CryptoScopeSelection::parse(next_flag_value(
                args, &mut idx, "--scope",
            )?)?);
        } else {
            return Err(AppError::Config(format!("unknown option {arg}")));
        }
    }
    let org_id = org_id.ok_or_else(|| AppError::Config("--org <uuid> is required".to_owned()))?;
    Ok(CryptoCliCommand::RotateTenantDek {
        org_id,
        scope: scope.unwrap_or(CryptoScopeSelection::All),
    })
}

fn parse_rewrap_master_kek_args(args: &[String]) -> Result<CryptoCliCommand, AppError> {
    let mut org_id: Option<Uuid> = None;
    let mut scope: Option<CryptoScopeSelection> = None;
    let mut batch_size = DEFAULT_BATCH_SIZE;
    let mut max_batches = CLI_DEFAULT_MAX_BATCHES_PER_ORG;
    let mut idx = 0;
    while idx < args.len() {
        let arg = args[idx].as_str();
        if arg == "--org" || arg.starts_with("--org=") {
            if org_id.is_some() {
                return Err(AppError::Config("duplicate --org option".to_owned()));
            }
            org_id = Some(parse_org_uuid(next_flag_value(args, &mut idx, "--org")?)?);
        } else if arg == "--scope" || arg.starts_with("--scope=") {
            if scope.is_some() {
                return Err(AppError::Config("duplicate --scope option".to_owned()));
            }
            scope = Some(CryptoScopeSelection::parse(next_flag_value(
                args, &mut idx, "--scope",
            )?)?);
        } else if arg == "--batch-size" || arg.starts_with("--batch-size=") {
            batch_size = parse_positive_i64(
                "--batch-size",
                next_flag_value(args, &mut idx, "--batch-size")?,
            )?;
        } else if arg == "--max-batches" || arg.starts_with("--max-batches=") {
            max_batches = parse_positive_usize(
                "--max-batches",
                next_flag_value(args, &mut idx, "--max-batches")?,
            )?;
        } else {
            return Err(AppError::Config(format!("unknown option {arg}")));
        }
    }
    Ok(CryptoCliCommand::RewrapMasterKek {
        org_id,
        scope: scope.unwrap_or(CryptoScopeSelection::All),
        batch_size,
        max_batches,
    })
}

#[cfg(test)]
#[path = "crypto_reseal_cli_tests.rs"]
mod tests;
