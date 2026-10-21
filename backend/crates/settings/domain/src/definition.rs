//! What one setting key is: its value kind, code default, bounds, which way
//! is looser, who may change it, and the citation behind a legal bound.

use console_kernel_core::OfficialSource;
use serde::Serialize;

/// The unit an integer setting counts in. Each key has exactly one unit, so
/// comparisons and range checks are plain integer comparisons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    BusinessDays,
    Days,
    Hours,
    Minutes,
    Months,
    Years,
    Percent,
    /// Bytes in units of 1 MiB (import caps).
    Mebibytes,
    /// Wall-clock milliseconds (process timeouts).
    Milliseconds,
    /// A plain count (entries, cells, a ratio).
    Count,
}

/// The value shape of a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum SettingKind {
    Int {
        unit: Unit,
        min: Option<i64>,
        max: Option<i64>,
    },
    Bool,
    /// Allowed codes, **strictest first**: a later code is looser.
    Code {
        allowed: &'static [&'static str],
    },
}

/// A setting value. Codes are always one of the key's `allowed` literals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum SettingValue {
    Int(i64),
    Bool(bool),
    Code(&'static str),
}

/// Which direction of change loosens the control (decisions D0.3
/// `risk_direction`). The test applied to every key: which way would an
/// insider who wants to get around the control push it?
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LooserWhen {
    Higher,
    Lower,
    /// Neither direction is a loosening (facts, platform switches).
    Neutral,
}

/// Who may write an override for the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Governance {
    /// Tenant or entity override rows, subject to the change rules.
    Tenant,
    /// Fixed by law; the code default is the only value.
    Fixed,
    /// A platform switch; no tenant row may exist.
    PlatformOnly,
    /// Mirrors infrastructure config; shown, never written.
    ReadOnly,
}

/// One key's definition. `default: None` marks a tenant fact with no default
/// (`fact: true` in D0.3): it must be declared before it can be resolved.
///
/// A legal floor or ceiling is encoded as `min`/`max` with the code default
/// sitting on it, so "only tighten past a legal default" is the range check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SettingDef {
    pub kind: SettingKind,
    pub default: Option<SettingValue>,
    pub looser_when: LooserWhen,
    pub governance: Governance,
    pub legal_basis: Option<OfficialSource>,
}

impl SettingDef {
    #[must_use]
    pub const fn int(
        unit: Unit,
        min: Option<i64>,
        max: Option<i64>,
        default: i64,
        looser_when: LooserWhen,
    ) -> Self {
        Self::new(
            SettingKind::Int { unit, min, max },
            Some(SettingValue::Int(default)),
            looser_when,
        )
    }

    /// An integer tenant fact: no default, no product bounds.
    #[must_use]
    pub const fn int_fact(unit: Unit, looser_when: LooserWhen) -> Self {
        Self::new(
            SettingKind::Int {
                unit,
                min: None,
                max: None,
            },
            None,
            looser_when,
        )
    }

    #[must_use]
    pub const fn bool(default: bool, looser_when: LooserWhen) -> Self {
        Self::new(
            SettingKind::Bool,
            Some(SettingValue::Bool(default)),
            looser_when,
        )
    }

    #[must_use]
    pub const fn bool_fact(looser_when: LooserWhen) -> Self {
        Self::new(SettingKind::Bool, None, looser_when)
    }

    #[must_use]
    pub const fn code(
        allowed: &'static [&'static str],
        default: &'static str,
        looser_when: LooserWhen,
    ) -> Self {
        Self::new(
            SettingKind::Code { allowed },
            Some(SettingValue::Code(default)),
            looser_when,
        )
    }

    #[must_use]
    pub const fn code_fact(allowed: &'static [&'static str]) -> Self {
        Self::new(SettingKind::Code { allowed }, None, LooserWhen::Neutral)
    }

    #[must_use]
    pub const fn cited(mut self, source: OfficialSource) -> Self {
        self.legal_basis = Some(source);
        self
    }

    #[must_use]
    pub const fn governed(mut self, governance: Governance) -> Self {
        self.governance = governance;
        self
    }

    const fn new(
        kind: SettingKind,
        default: Option<SettingValue>,
        looser_when: LooserWhen,
    ) -> Self {
        Self {
            kind,
            default,
            looser_when,
            governance: Governance::Tenant,
            legal_basis: None,
        }
    }

    /// True for a tenant fact that has no code default.
    #[must_use]
    pub const fn is_fact(&self) -> bool {
        self.default.is_none()
    }

    /// The comparable position of a value of this key: the integer itself,
    /// `0`/`1` for a bool, the index in `allowed` for a code. `None` when the
    /// value does not belong to this key's kind.
    #[must_use]
    pub fn ordinal(&self, value: SettingValue) -> Option<i64> {
        match (self.kind, value) {
            (SettingKind::Int { .. }, SettingValue::Int(v)) => Some(v),
            (SettingKind::Bool, SettingValue::Bool(b)) => Some(i64::from(b)),
            (SettingKind::Code { allowed }, SettingValue::Code(c)) => allowed
                .iter()
                .position(|a| *a == c)
                .and_then(|i| i64::try_from(i).ok()),
            _ => None,
        }
    }
}
