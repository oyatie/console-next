//! The change rules a new override row must pass (decisions D0.3). The
//! `BEFORE INSERT` trigger in the BW-00 migration enforces the same rules in
//! the database; this is the same check, run first so the caller gets a
//! coded refusal and knows whether the change is a loosening (step-up, notice
//! to every EXECUTIVE and SUPER_ADMIN and the security contact, case-A act).

use crate::{Governance, LooserWhen, SettingError, SettingKey, SettingValue};
use console_kernel_core::Timestamp;
use serde_json::Value;
use time::Duration;

/// How long a loosening waits before it can take effect (D0.3). A rule of
/// the registry itself, not a tenant setting: a setting for it could loosen
/// its own guard.
pub const LOOSENING_DELAY: Duration = Duration::hours(24);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Tighten,
    Loosen,
    /// Same value, or a key where neither direction is looser.
    Neutral,
}

/// A change validated against the rules, ready to insert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcceptedChange {
    pub value: SettingValue,
    pub direction: Direction,
}

/// Which way `proposed` moves from `in_force`. Declaring a fact for the first
/// time (`in_force: None`) counts as a loosening unless the key is neutral.
#[must_use]
pub fn direction(
    key: SettingKey,
    in_force: Option<SettingValue>,
    proposed: SettingValue,
) -> Direction {
    let def = key.def();
    if def.looser_when == LooserWhen::Neutral {
        return Direction::Neutral;
    }
    let Some(current) = in_force else {
        return Direction::Loosen;
    };
    let (Some(from), Some(to)) = (def.ordinal(current), def.ordinal(proposed)) else {
        return Direction::Loosen;
    };
    let looser = match def.looser_when {
        LooserWhen::Higher => to > from,
        LooserWhen::Lower => to < from,
        LooserWhen::Neutral => false,
    };
    if from == to {
        Direction::Neutral
    } else if looser {
        Direction::Loosen
    } else {
        Direction::Tighten
    }
}

/// Validates a proposed override row.
///
/// - `in_force`: the value the row replaces: [`crate::resolve`] at the row's
///   scope as of `effective_from` (so a row scheduled inside the delay is
///   compared with what will actually be in force then); `None` for an
///   undeclared fact.
/// - `onboarding`: the tenant has no employees and no applied payroll period,
///   so no decision was made under the old value and a loosening applies
///   immediately (still recorded).
///
/// # Errors
/// The first rule the change breaks, as a coded [`SettingError`].
pub fn check_change(
    key: SettingKey,
    raw: &Value,
    effective_from: Timestamp,
    now: Timestamp,
    in_force: Option<SettingValue>,
    onboarding: bool,
) -> Result<AcceptedChange, SettingError> {
    let def = key.def();
    if def.governance != Governance::Tenant {
        return Err(SettingError::NotEditable(key));
    }
    let value = def.parse(raw).ok_or(SettingError::InvalidValue(key))?;
    if !def.in_range(value) {
        return Err(SettingError::OutOfRange(key));
    }
    if effective_from < now {
        return Err(SettingError::Backdated(key));
    }
    let direction = direction(key, in_force, value);
    let earliest = now + LOOSENING_DELAY;
    if direction == Direction::Loosen && !onboarding && effective_from < earliest {
        return Err(SettingError::LooseningTooSoon { key, earliest });
    }
    Ok(AcceptedChange { value, direction })
}
