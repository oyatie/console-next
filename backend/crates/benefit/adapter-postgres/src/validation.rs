// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::KernelError;
use time::Date;

pub(super) fn normalize_non_negative_i32(
    value: Option<i32>,
    field: &str,
) -> Result<Option<i32>, KernelError> {
    if value.is_some_and(|value| value < 0) {
        Err(KernelError::validation(format!(
            "{field} must be non-negative"
        )))
    } else {
        Ok(value)
    }
}

pub(super) fn validate_dates(
    effective_on: Option<Date>,
    retires_on: Option<Date>,
) -> Result<(), KernelError> {
    if let (Some(effective_on), Some(retires_on)) = (effective_on, retires_on)
        && retires_on < effective_on
    {
        return Err(KernelError::validation(
            "retires_on must be on or after effective_on",
        ));
    }
    Ok(())
}
