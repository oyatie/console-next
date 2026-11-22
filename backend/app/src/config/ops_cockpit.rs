// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use console_ops_domain::bundle::{
    ComponentsMap, OncallConfig, OpsSettings, validate_components_json, validate_oncall_json,
    validate_ops_settings_json,
};
use console_ops_rest::access_jwt::parse_jwks;
use console_ops_rest::operators::OperatorRegistry;
use console_ops_rest::validate_runbooks_dir;

use crate::config::parse::non_empty;
use crate::error::AppError;

pub(crate) const DEFAULT_OPS_CONFIG_DIR: &str = "/etc/console/ops";
pub(crate) const DEFAULT_OPS_SERVICE_NAME: &str = "console-app-ops";

#[derive(Debug, Clone)]
pub struct OpsCockpitConfig {
    pub config_dir: PathBuf,
    pub records_dir: Option<PathBuf>,
    pub releases_dir: Option<PathBuf>,
    pub state_dir: Option<PathBuf>,
    pub status_url: Option<String>,
    pub components: ComponentsMap,
    pub settings: OpsSettings,
    pub operators_json: String,
    pub oncall: Option<OncallConfig>,
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

pub fn load_from_vars(vars: &HashMap<String, String>) -> Result<OpsCockpitConfig, AppError> {
    let config_dir = non_empty(vars.get("CONSOLE_OPS_CONFIG_DIR"))
        .unwrap_or_else(|| DEFAULT_OPS_CONFIG_DIR.to_owned());
    let records_dir = non_empty(vars.get("CONSOLE_OPS_RECORDS_DIR")).map(PathBuf::from);
    let mut cfg = load_and_validate(Path::new(&config_dir), records_dir)?;
    cfg.releases_dir = non_empty(vars.get("CONSOLE_OPS_RELEASES_DIR")).map(PathBuf::from);
    cfg.state_dir = non_empty(vars.get("CONSOLE_OPS_STATE_DIR")).map(PathBuf::from);
    cfg.status_url = non_empty(vars.get("CONSOLE_OPS_STATUS_URL"));
    Ok(cfg)
}

fn validate_optional_oncall_and_runbooks(
    config_dir: &Path,
    registry: &OperatorRegistry,
) -> Result<Option<OncallConfig>, AppError> {
    let oncall_path = config_dir.join("oncall.json");
    let oncall = match std::fs::symlink_metadata(&oncall_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(invalid(&oncall_path, "", e)),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err(invalid(&oncall_path, "", "expected regular file"));
        }
        Ok(_) => {
            let raw = read_file(&oncall_path)?;
            let person_ids = registry.person_ids();
            let refs: Vec<&str> = person_ids.iter().map(String::as_str).collect();
            let parsed = validate_oncall_json(&raw, Some(&refs))
                .map_err(|e| invalid(&oncall_path, &e.pointer, e.message))?;
            Some(parsed)
        }
    };

    let runbooks_path = config_dir.join("runbooks");
    match std::fs::symlink_metadata(&runbooks_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(invalid(&runbooks_path, "", e)),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(invalid(&runbooks_path, "", "expected regular directory"));
        }
        Ok(_) => {
            validate_runbooks_dir(config_dir).map_err(|msg| invalid(&runbooks_path, "", msg))?;
        }
    }

    Ok(oncall)
}

fn load_core_bundle(
    config_dir: &Path,
) -> Result<(ComponentsMap, OpsSettings, String, Option<OncallConfig>), AppError> {
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
    let registry = OperatorRegistry::from_json(&operators_json).map_err(|msg| {
        if let Some((ptr, detail)) = msg.split_once(": ")
            && ptr.starts_with('/')
        {
            invalid(&ops_path, ptr, detail)
        } else {
            invalid(&ops_path, "", msg)
        }
    })?;

    let oncall = validate_optional_oncall_and_runbooks(config_dir, &registry)?;
    Ok((components, settings, operators_json, oncall))
}

pub fn load_and_validate(
    config_dir: &Path,
    records_dir: Option<PathBuf>,
) -> Result<OpsCockpitConfig, AppError> {
    let (components, settings, operators_json, oncall) = load_core_bundle(config_dir)?;
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
        releases_dir: None,
        state_dir: None,
        status_url: None,
        components,
        settings,
        operators_json,
        oncall,
        jwks_path,
    })
}

pub fn validate_bundle_dir(config_dir: &Path) -> Result<OpsCockpitConfig, AppError> {
    let (components, settings, operators_json, oncall) = load_core_bundle(config_dir)?;
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
        releases_dir: None,
        state_dir: None,
        status_url: None,
        components,
        settings,
        operators_json,
        oncall,
        jwks_path: Some(jwks_path),
    })
}
