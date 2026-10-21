//! Object-storage configuration.

use crate::config::parse::non_empty;
use crate::error::AppError;
use console_platform_storage::S3StorageConfig;
use std::collections::HashMap;

pub(crate) fn storage_config_from_vars(
    vars: &HashMap<String, String>,
) -> Result<Option<S3StorageConfig>, AppError> {
    let Some(endpoint_url) = non_empty(vars.get("CONSOLE_S3_ENDPOINT_URL")) else {
        return Ok(None);
    };
    let required = |name: &'static str| {
        non_empty(vars.get(name)).ok_or_else(|| {
            AppError::Config(format!("{name} is required when S3 storage is configured"))
        })
    };
    let force_path_style = match non_empty(vars.get("CONSOLE_S3_FORCE_PATH_STYLE")) {
        Some(raw) => raw.parse::<bool>().map_err(|err| {
            AppError::Config(format!("invalid CONSOLE_S3_FORCE_PATH_STYLE: {err}"))
        })?,
        None => true,
    };

    Ok(Some(S3StorageConfig {
        endpoint_url,
        region: non_empty(vars.get("CONSOLE_S3_REGION")).unwrap_or_else(|| "us-east-1".to_owned()),
        access_key_id: required("CONSOLE_S3_ACCESS_KEY_ID")?,
        secret_access_key: required("CONSOLE_S3_SECRET_ACCESS_KEY")?,
        primary_bucket: required("CONSOLE_S3_PRIMARY_BUCKET")?,
        replica_bucket: required("CONSOLE_S3_REPLICA_BUCKET")?,
        force_path_style,
    }))
}
