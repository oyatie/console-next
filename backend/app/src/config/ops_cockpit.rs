// SPDX-License-Identifier: LicenseRef-Proprietary
use std::path::{Path, PathBuf};

use console_ops_domain::bundle::{
    ComponentsMap, OpsSettings, validate_components_json, validate_ops_settings_json,
};
use console_ops_rest::access_jwt::parse_jwks;
use console_ops_rest::operators::OperatorRegistry;

use crate::error::AppError;

pub(crate) const DEFAULT_OPS_CONFIG_DIR: &str = "/etc/console/ops";
pub(crate) const DEFAULT_OPS_SERVICE_NAME: &str = "console-app-ops";

#[derive(Debug, Clone)]
pub struct OpsCockpitConfig {
    pub config_dir: PathBuf,
    pub records_dir: Option<PathBuf>,
    pub components: ComponentsMap,
    pub settings: OpsSettings,
    pub operators_json: String,
    pub jwks_path: Option<PathBuf>,
}

fn invalid(path: &Path, pointer: &str, message: impl std::fmt::Display) -> AppError {
    let ptr = if pointer.is_empty() || pointer.starts_with('/') {
        pointer.to_owned()
    } else {
        format!("/{pointer}")
    };
    AppError::OpsConfig(format!(
        "OPS_CONFIG_INVALID: {}#{ptr}: {message}",
        path.display()
    ))
}

fn read_file(path: &Path) -> Result<String, AppError> {
    std::fs::read_to_string(path).map_err(|e| invalid(path, "", e))
}

pub fn load_and_validate(
    config_dir: &Path,
    records_dir: Option<PathBuf>,
) -> Result<OpsCockpitConfig, AppError> {
    let comp_path = config_dir.join("components.json");
    let comp_raw = read_file(&comp_path)?;
    let components = validate_components_json(&comp_raw)
        .map_err(|e| invalid(&comp_path, &e.pointer, e.message))?;

    let settings_path = config_dir.join("ops-settings.json");
    let settings_raw = read_file(&settings_path)?;
    let settings = validate_ops_settings_json(&settings_raw)
        .map_err(|e| invalid(&settings_path, &e.pointer, e.message))?;

    let ops_path = config_dir.join("operators.json");
    let operators_json = read_file(&ops_path)?;
    OperatorRegistry::from_json(&operators_json).map_err(|msg| {
        if let Some((ptr, detail)) = msg.split_once(": ")
            && ptr.starts_with('/')
        {
            invalid(&ops_path, ptr, detail)
        } else {
            invalid(&ops_path, "", msg)
        }
    })?;

    let jwks_path = if settings.access.jwks.starts_with('/') {
        let path = PathBuf::from(&settings.access.jwks);
        let jwks_raw = read_file(&path)?;
        parse_jwks(&jwks_raw).map_err(|msg| {
            if let Some((ptr, detail)) = msg.split_once(": ")
                && ptr.starts_with('/')
            {
                invalid(&path, ptr, detail)
            } else {
                invalid(&path, "", msg)
            }
        })?;
        Some(path)
    } else {
        None
    };

    Ok(OpsCockpitConfig {
        config_dir: config_dir.to_path_buf(),
        records_dir,
        components,
        settings,
        operators_json,
        jwks_path,
    })
}

pub fn validate_bundle_dir(config_dir: &Path) -> Result<OpsCockpitConfig, AppError> {
    let comp_path = config_dir.join("components.json");
    let comp_raw = read_file(&comp_path)?;
    let components = validate_components_json(&comp_raw)
        .map_err(|e| invalid(&comp_path, &e.pointer, e.message))?;

    let settings_path = config_dir.join("ops-settings.json");
    let settings_raw = read_file(&settings_path)?;
    let settings = validate_ops_settings_json(&settings_raw)
        .map_err(|e| invalid(&settings_path, &e.pointer, e.message))?;

    let ops_path = config_dir.join("operators.json");
    let operators_json = read_file(&ops_path)?;
    OperatorRegistry::from_json(&operators_json).map_err(|msg| {
        if let Some((ptr, detail)) = msg.split_once(": ")
            && ptr.starts_with('/')
        {
            invalid(&ops_path, ptr, detail)
        } else {
            invalid(&ops_path, "", msg)
        }
    })?;

    let jwks_path = config_dir.join("access-jwks.json");
    let jwks_raw = read_file(&jwks_path)?;
    parse_jwks(&jwks_raw).map_err(|msg| {
        if let Some((ptr, detail)) = msg.split_once(": ")
            && ptr.starts_with('/')
        {
            invalid(&jwks_path, ptr, detail)
        } else {
            invalid(&jwks_path, "", msg)
        }
    })?;

    Ok(OpsCockpitConfig {
        config_dir: config_dir.to_path_buf(),
        records_dir: None,
        components,
        settings,
        operators_json,
        jwks_path: Some(jwks_path),
    })
}
