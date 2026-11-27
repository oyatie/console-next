//! Refusals from the settings registry. Each carries a stable code (rendered
//! by the frontend catalog first) and the input field it points at.

use crate::SettingKey;
use console_kernel_core::{KernelError, Timestamp};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingError {
    /// The key has no tenant override path (fixed by law, platform-only or
    /// read-only).
    NotEditable(SettingKey),
    /// The value is not of the key's kind (or not one of its codes).
    InvalidValue(SettingKey),
    /// The value is outside the key's code range or legal bound.
    OutOfRange(SettingKey),
    /// `effective_from` is before now; settings are never back-dated.
    Backdated(SettingKey),
    /// A loosening must wait out the delay; `earliest` is the first allowed
    /// `effective_from`.
    LooseningTooSoon {
        key: SettingKey,
        earliest: Timestamp,
    },
    /// A tenant fact with no default has not been declared yet.
    FactUndeclared(SettingKey),
    /// The target scope is finer than the key's allowed override ceiling.
    ScopeNotAllowed(SettingKey),
    /// The value is allowed only on scoped overrides, not at the tenant root.
    TenantRootDisallowed(SettingKey),
    /// An individual person override cannot be less favorable to the worker than the inherited rule.
    PersonOverrideDisfavorable(SettingKey),
}

impl SettingError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::NotEditable(_) => "setting_not_editable",
            Self::InvalidValue(_) => "setting_value_invalid",
            Self::OutOfRange(_) => "setting_out_of_range",
            Self::Backdated(_) => "setting_backdated",
            Self::LooseningTooSoon { .. } => "setting_loosening_too_soon",
            Self::FactUndeclared(_) => "setting_fact_undeclared",
            Self::ScopeNotAllowed(_) => "setting_scope_not_allowed",
            Self::TenantRootDisallowed(_) => "setting_tenant_root_disallowed",
            Self::PersonOverrideDisfavorable(_) => "setting_person_disfavorable",
        }
    }

    #[must_use]
    pub const fn field(&self) -> &'static str {
        match self {
            Self::Backdated(_) | Self::LooseningTooSoon { .. } => "effective_from",
            Self::NotEditable(_) | Self::FactUndeclared(_) => "key",
            Self::ScopeNotAllowed(_) => "scope_entity_id",
            Self::InvalidValue(_)
            | Self::OutOfRange(_)
            | Self::TenantRootDisallowed(_)
            | Self::PersonOverrideDisfavorable(_) => "value",
        }
    }
}

impl std::fmt::Display for SettingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotEditable(k) => {
                write!(f, "setting {} cannot be changed by a tenant", k.as_str())
            }
            Self::InvalidValue(k) => write!(f, "value is not valid for setting {}", k.as_str()),
            Self::OutOfRange(k) => write!(
                f,
                "value is outside the allowed range for setting {}",
                k.as_str()
            ),
            Self::Backdated(k) => {
                write!(f, "setting {} cannot take effect in the past", k.as_str())
            }
            Self::LooseningTooSoon { key, earliest } => write!(
                f,
                "loosening setting {} can take effect at {earliest} at the earliest",
                key.as_str()
            ),
            Self::FactUndeclared(k) => write!(f, "setting {} has not been declared", k.as_str()),
            Self::ScopeNotAllowed(k) => {
                write!(
                    f,
                    "setting {} cannot be overridden at this scope",
                    k.as_str()
                )
            }
            Self::TenantRootDisallowed(k) => {
                write!(
                    f,
                    "this value is not allowed at the tenant root for setting {}",
                    k.as_str()
                )
            }
            Self::PersonOverrideDisfavorable(k) => write!(
                f,
                "an individual override for setting {} cannot be less favorable to the worker",
                k.as_str()
            ),
        }
    }
}

impl std::error::Error for SettingError {}

impl From<SettingError> for KernelError {
    fn from(error: SettingError) -> Self {
        // NotEditable is a fact about the key, not the actor (who may change
        // what is Cedar's), so it is a validation refusal, not 403.
        let base = match error {
            SettingError::FactUndeclared(_) => KernelError::conflict(error.to_string()),
            _ => KernelError::validation(error.to_string()),
        };
        base.with_code(error.code()).with_field(error.field())
    }
}
