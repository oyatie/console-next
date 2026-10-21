//! Reading a raw (JSON) value into a typed [`SettingValue`] and checking it
//! against the key's range.

use crate::{SettingDef, SettingKind, SettingValue};
use serde_json::Value;

impl SettingDef {
    /// The typed value, or `None` if `raw` is not of this key's kind.
    #[must_use]
    pub fn parse(&self, raw: &Value) -> Option<SettingValue> {
        match (self.kind, raw) {
            (SettingKind::Int { .. }, Value::Number(n)) => n.as_i64().map(SettingValue::Int),
            (SettingKind::Bool, Value::Bool(b)) => Some(SettingValue::Bool(*b)),
            (SettingKind::Code { allowed }, Value::String(s)) => allowed
                .iter()
                .find(|a| **a == s.as_str())
                .map(|a| SettingValue::Code(a)),
            _ => None,
        }
    }

    /// True when the value is of this key's kind and inside `min..=max`.
    #[must_use]
    pub fn in_range(&self, value: SettingValue) -> bool {
        match (self.kind, value) {
            (SettingKind::Int { min, max, .. }, SettingValue::Int(v)) => {
                min.is_none_or(|m| v >= m) && max.is_none_or(|m| v <= m)
            }
            _ => self.ordinal(value).is_some(),
        }
    }
}

impl SettingValue {
    #[must_use]
    pub const fn as_int(self) -> Option<i64> {
        match self {
            Self::Int(v) => Some(v),
            _ => None,
        }
    }

    #[must_use]
    pub const fn as_bool(self) -> Option<bool> {
        match self {
            Self::Bool(v) => Some(v),
            _ => None,
        }
    }

    #[must_use]
    pub const fn as_code(self) -> Option<&'static str> {
        match self {
            Self::Code(v) => Some(v),
            _ => None,
        }
    }
}
