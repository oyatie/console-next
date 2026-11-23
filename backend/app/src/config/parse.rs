//! Small environment-value parsers shared by the config modules.

use crate::error::AppError;
use base64::Engine as _;
use std::time::Duration;

pub(crate) fn parse_bool(
    raw: Option<&String>,
    default: bool,
    name: &str,
) -> Result<bool, AppError> {
    match raw {
        Some(raw) => raw
            .parse::<bool>()
            .map_err(|err| AppError::Config(format!("invalid {name}: {err}"))),
        None => Ok(default),
    }
}

pub(crate) fn parse_duration_secs(
    raw: Option<&String>,
    default: Duration,
    name: &str,
) -> Result<Duration, AppError> {
    match raw {
        Some(raw) => raw
            .parse::<u64>()
            .map(Duration::from_secs)
            .map_err(|err| AppError::Config(format!("invalid {name}: {err}"))),
        None => Ok(default),
    }
}

pub(crate) fn parse_base64_key_32(
    raw: Option<&String>,
    name: &str,
) -> Result<Option<[u8; 32]>, AppError> {
    non_empty(raw)
        .map(|encoded| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| AppError::Config(format!("{name} must be base64")))?;
            bytes.try_into().map_err(|_: Vec<u8>| {
                AppError::Config(format!("{name} must decode to exactly 32 bytes"))
            })
        })
        .transpose()
}

pub(crate) fn parse_time_duration_secs(
    raw: Option<&String>,
    default_secs: u64,
    name: &str,
) -> Result<time::Duration, AppError> {
    let secs = match raw {
        Some(raw) => raw
            .parse::<i64>()
            .map_err(|err| AppError::Config(format!("invalid {name}: {err}")))?,
        None => i64::try_from(default_secs)
            .map_err(|err| AppError::Config(format!("invalid default for {name}: {err}")))?,
    };
    Ok(time::Duration::seconds(secs))
}

pub(crate) fn non_empty(value: Option<&String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}
