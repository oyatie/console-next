//! H6c: secrets from files, not the container's environment. Any variable the
//! app reads may instead be given as `<NAME>_FILE=<path>` (the Docker secrets
//! and official-image convention): the file's content becomes `<NAME>`, so the
//! value never sits in the container config or `docker inspect`. Setting both
//! is an error; only trailing newlines are trimmed (a PEM keeps its inner ones).

use std::collections::HashMap;

use crate::error::AppError;

/// `*_FILE` variables that are paths in their own right, never secrets.
const PATH_VARS: &[&str] = &["CONSOLE_DEV_LIFECYCLE_TODAY_FILE"];

/// Only the app's own names: `SSL_CERT_FILE` and friends belong to libraries.
fn app_secret(name: &str) -> bool {
    name.starts_with("CONSOLE_") || name.ends_with("DATABASE_URL") || name.ends_with("_API_KEY")
}

fn read(name: &str, path: &str) -> Result<String, AppError> {
    std::fs::read_to_string(path)
        .map(|value| value.trim_end_matches(['\n', '\r']).to_owned())
        .map_err(|err| AppError::Config(format!("{name}_FILE: cannot read it ({})", err.kind())))
}

fn both(name: &str) -> AppError {
    AppError::Config(format!("set {name} or {name}_FILE, not both"))
}

/// Replace every `<NAME>_FILE` in `vars` with `<NAME>` read from that file.
pub(crate) fn resolve_file_vars(vars: &mut HashMap<String, String>) -> Result<(), AppError> {
    let files: Vec<(String, String)> = vars
        .iter()
        .filter(|(key, _)| !PATH_VARS.contains(&key.as_str()))
        .filter_map(|(key, path)| Some((key.strip_suffix("_FILE")?.to_owned(), path.clone())))
        .filter(|(name, _)| app_secret(name))
        .collect();
    for (name, path) in files {
        if vars.contains_key(&name) {
            return Err(both(&name));
        }
        let value = read(&name, &path)?;
        vars.insert(name, value);
    }
    Ok(())
}

/// One secret through `get` (`std::env::var` in production): `<NAME>`, or
/// the content of `<NAME>_FILE`. For the readers outside `AppConfig`.
pub(crate) fn secret(
    name: &str,
    get: impl Fn(&str) -> Option<String>,
) -> Result<Option<String>, AppError> {
    match (get(name), get(&format!("{name}_FILE"))) {
        (Some(_), Some(_)) => Err(both(name)),
        (value, None) => Ok(value),
        (None, Some(path)) => read(name, &path).map(Some),
    }
}

/// [`secret`] from the process environment.
pub(crate) fn secret_env(name: &str) -> Result<Option<String>, AppError> {
    secret(name, |key| std::env::var(key).ok())
}

#[cfg(test)]
#[path = "secret_files_tests.rs"]
mod tests;
