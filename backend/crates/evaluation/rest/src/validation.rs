// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{RestError, validation};

pub(super) fn bounded_required(
    value: &str,
    min: usize,
    max: usize,
    field: &str,
) -> Result<String, RestError> {
    let trimmed = value.trim();
    let chars = trimmed.chars().count();
    if chars < min || chars > max {
        return Err(validation(format!(
            "{field} must be between {min} and {max} characters"
        )));
    }
    Ok(trimmed.to_owned())
}

/// Bound an optional text field; a present-but-blank value normalizes to None.
pub(super) fn bounded_optional(
    value: &str,
    max: usize,
    field: &str,
) -> Result<Option<String>, RestError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > max {
        return Err(validation(format!(
            "{field} must be at most {max} characters"
        )));
    }
    Ok(Some(trimmed.to_owned()))
}

pub(super) fn validated_weight(weight_pct: i16) -> Result<i16, RestError> {
    if (0..=100).contains(&weight_pct) {
        Ok(weight_pct)
    } else {
        Err(validation("weight_pct must be between 0 and 100"))
    }
}
