//! Shared vocabulary for source-versioned policy values (backend challenge A5).
//!
//! Settings, payroll, hr and every policy consumer use these types, so they
//! live in the kernel: domain crates may depend only on the kernel. Types only;
//! no values. Concrete sources and periods stay in the owning context.

use crate::Date;

/// The official instrument a legal number comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct OfficialSource {
    pub authority: &'static str,
    pub title: &'static str,
    pub url: &'static str,
    pub retrieved_on: Date,
}

/// A half-open date range `[from, to_exclusive)`; `None` means open-ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EffectivePeriod {
    pub from: Date,
    pub to_exclusive: Option<Date>,
}

impl EffectivePeriod {
    #[must_use]
    pub const fn new(from: Date, to_exclusive: Option<Date>) -> Self {
        Self { from, to_exclusive }
    }

    #[must_use]
    pub fn contains(self, day: Date) -> bool {
        day >= self.from && self.to_exclusive.is_none_or(|to| day < to)
    }
}

/// Which version of a setting a value was resolved from. No override row
/// means the code default (decisions D0.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingVersionId {
    CodeDefault,
    /// The id of the append-only override row that supplied the value.
    Override(uuid::Uuid),
}

/// A resolved setting value plus the version it came from. The application
/// layer unwraps it for ring-1 functions and records `version`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Resolved<T> {
    pub value: T,
    pub version: SettingVersionId,
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn effective_period_is_half_open() {
        let p = EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01)));
        assert!(!p.contains(date!(2025 - 12 - 31)));
        assert!(p.contains(date!(2026 - 01 - 01)));
        assert!(p.contains(date!(2026 - 12 - 31)));
        assert!(!p.contains(date!(2027 - 01 - 01)));
        assert!(EffectivePeriod::new(date!(2026 - 01 - 01), None).contains(date!(2999 - 01 - 01)));
    }

    #[test]
    fn resolved_round_trips_both_versions() {
        let id = uuid::Uuid::nil();
        for version in [
            SettingVersionId::CodeDefault,
            SettingVersionId::Override(id),
        ] {
            let r = Resolved {
                value: 7_u16,
                version,
            };
            let json = serde_json::to_string(&r).unwrap();
            assert_eq!(serde_json::from_str::<Resolved<u16>>(&json).unwrap(), r);
        }
        assert_eq!(
            serde_json::to_string(&SettingVersionId::CodeDefault).unwrap(),
            "\"code_default\""
        );
    }
}
