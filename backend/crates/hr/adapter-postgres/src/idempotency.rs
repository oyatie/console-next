//! Idempotency refusals shared by the HR write paths (moved from
//! `app/src/hr.rs`, R2-exits).

use console_hr_domain::text::normalize_optional_text;
use console_kernel_core::KernelError;
use console_platform_db::idempotency::IDEMPOTENCY_KEY_REUSED;

use crate::HrError;

pub fn idempotency_key_reused() -> HrError {
    HrError::from_kernel(KernelError::conflict(IDEMPOTENCY_KEY_REUSED))
}

pub fn normalize_idempotency_key(value: String) -> Result<String, HrError> {
    let value = normalize_optional_text(Some(value))
        .ok_or_else(|| HrError::validation("idempotency key is required"))?;
    if value.chars().count() > 128 {
        return Err(HrError::validation(
            "idempotency key must be 128 characters or fewer",
        ));
    }
    Ok(value)
}
